// libp2p-metrics-adapter.test.ts
//
// Unit tests for the byte-counting libp2p Metrics adapter shipped in
// the relay-observability PR (PR2 of the libp2p reachability hardening
// series). Three contracts under test:
//
//   1. `isRelayServerStream` — the predicate that decides whether a
//      libp2p Stream should be byte-counted. Production passes only
//      HOP/STOP relay-server streams through the adapter; we verify
//      both the positive and negative paths. (Replaces the previous
//      `isCircuitRelayConnection` predicate, which counted zero on
//      real relay servers — see branarakic's PR #525 review:
//      forwarded relay traffic does not flow over `/p2p-circuit`
//      MultiaddrConnections on the relay host; the relay pipes raw
//      HOP+STOP protocol streams together internally.)
//
//   2. The no-op surface — registerMetric/Group/Counter/Histogram/Summary
//      return objects whose methods don't throw. libp2p calls these at
//      startup for its built-in metrics modules; if any returned object
//      is missing a method, libp2p will TypeError in production. We
//      therefore exercise every method on every returned shape.
//
//   3. `trackProtocolStream` — the only "real" code path. Subscribes to
//      the stream's `'message'` event for inbound bytes and wraps
//      `.send()` for outbound bytes. We simulate traffic via both
//      surfaces and assert the running totals.
//      `trackMultiaddrConnection` is now a no-op (counting at the
//      connection level would inflate totals by including non-relay
//      streams like DHT / gossipsub).

import { describe, it, expect } from 'vitest';
import {
  RelayMetricsAdapter,
  isRelayServerStream,
  RELAY_V2_HOP_CODEC,
  RELAY_V2_STOP_CODEC,
  type RelayBytesSnapshot,
} from '../src/libp2p-metrics-adapter.js';

/**
 * Fake Stream minimal enough to flow through the adapter.
 * Inherits EventTarget so `addEventListener('message'|'close')` works
 * just like the real libp2p MessageStream contract. Direction defaults
 * to the server-side semantics for each codec (HOP=inbound, STOP=outbound)
 * so existing tests that didn't pass direction still hit the tracked path.
 */
class FakeStream extends EventTarget {
  readonly id: string;
  readonly protocol: string;
  readonly direction: 'inbound' | 'outbound';
  // Allow tests to make send() throw / return a promise to exercise the
  // bytesOut-after-send invariant introduced in the PR2 review round.
  sendImpl: ((data: any) => boolean | Promise<boolean>) | null = null;
  sentChunks: any[] = [];
  closed = false;

  constructor(
    protocol: string,
    id = 'stream-1',
    direction?: 'inbound' | 'outbound',
  ) {
    super();
    this.id = id;
    this.protocol = protocol;
    // Default to the relay-server-side direction for each codec so older
    // tests don't need to be touched.
    if (direction != null) {
      this.direction = direction;
    } else if (protocol === RELAY_V2_HOP_CODEC) {
      this.direction = 'inbound';
    } else if (protocol === RELAY_V2_STOP_CODEC) {
      this.direction = 'outbound';
    } else {
      this.direction = 'inbound';
    }
  }

  send(data: any): boolean | Promise<boolean> {
    if (this.sendImpl) return this.sendImpl(data);
    this.sentChunks.push(data);
    return true;
  }

  emitInbound(data: any): void {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  emitClose(): void {
    this.closed = true;
    this.dispatchEvent(new Event('close'));
  }
}

describe('isRelayServerStream', () => {
  it('accepts HOP inbound (dialer → relay) — the relay is receiving', () => {
    expect(
      isRelayServerStream({ protocol: RELAY_V2_HOP_CODEC, direction: 'inbound' } as any),
    ).toBe(true);
  });

  it('accepts STOP outbound (relay → reservee) — the relay is initiating', () => {
    expect(
      isRelayServerStream({ protocol: RELAY_V2_STOP_CODEC, direction: 'outbound' } as any),
    ).toBe(true);
  });

  it('rejects HOP outbound (this node dialing through some other relay — client side)', () => {
    // PR #525 round-2 review (branarakic): without this filter, a node
    // running the relay server AND configured with `relayPeers` would
    // double-count its own client-side traffic as "forwarded by this
    // relay". HOP outbound means we're the dialer, not the relay.
    expect(
      isRelayServerStream({ protocol: RELAY_V2_HOP_CODEC, direction: 'outbound' } as any),
    ).toBe(false);
  });

  it('rejects STOP inbound (this node IS the reservee receiving relayed traffic — client side)', () => {
    // Same scenario as above: STOP inbound means we're the reservee
    // and someone is forwarding bytes TO us — that's not "served by"
    // this relay.
    expect(
      isRelayServerStream({ protocol: RELAY_V2_STOP_CODEC, direction: 'inbound' } as any),
    ).toBe(false);
  });

  it('rejects unrelated protocol streams (DHT, gossipsub, identify) regardless of direction', () => {
    for (const dir of ['inbound', 'outbound'] as const) {
      expect(isRelayServerStream({ protocol: '/ipfs/kad/1.0.0', direction: dir } as any)).toBe(false);
      expect(isRelayServerStream({ protocol: '/meshsub/1.1.0', direction: dir } as any)).toBe(false);
      expect(isRelayServerStream({ protocol: '/ipfs/id/1.0.0', direction: dir } as any)).toBe(false);
    }
  });

  it('returns false defensively when protocol is missing or throws', () => {
    expect(isRelayServerStream({} as any)).toBe(false);
    expect(
      isRelayServerStream({
        get protocol() {
          throw new Error('boom');
        },
      } as any),
    ).toBe(false);
  });
});

describe('RelayMetricsAdapter — no-op surface', () => {
  it('returns Metric/Counter/Histogram/Summary objects whose methods do not throw', () => {
    const m = new RelayMetricsAdapter();

    // registerMetric — Metric has update/increment/decrement/reset/timer
    const metric = m.registerMetric('foo');
    expect(() => metric.update(1)).not.toThrow();
    expect(() => metric.increment()).not.toThrow();
    expect(() => metric.decrement()).not.toThrow();
    expect(() => metric.reset()).not.toThrow();
    const stop = metric.timer();
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();

    // registerMetricGroup — same shape but with `update(values)` etc.
    const group = m.registerMetricGroup('bar');
    expect(() => group.update({ key: 1 })).not.toThrow();
    expect(() => group.increment({ key: 1 })).not.toThrow();
    expect(() => group.decrement({ key: 1 })).not.toThrow();
    expect(() => group.reset()).not.toThrow();
    expect(() => group.timer('key')()).not.toThrow();

    // Counters — increment + reset only
    const counter = m.registerCounter('c1');
    expect(() => counter.increment()).not.toThrow();
    expect(() => counter.reset()).not.toThrow();

    const counterGroup = m.registerCounterGroup('cg');
    expect(() => counterGroup.increment({ a: 1 })).not.toThrow();
    expect(() => counterGroup.reset()).not.toThrow();

    // Histograms
    const hist = m.registerHistogram('h');
    expect(() => hist.observe(0.5)).not.toThrow();
    expect(() => hist.reset()).not.toThrow();
    expect(() => hist.timer()()).not.toThrow();

    const histGroup = m.registerHistogramGroup('hg');
    expect(() => histGroup.observe({ a: 0.5 })).not.toThrow();
    expect(() => histGroup.reset()).not.toThrow();

    // Summaries
    const sum = m.registerSummary('s');
    expect(() => sum.observe(0.5)).not.toThrow();
    expect(() => sum.reset()).not.toThrow();
    expect(() => sum.timer()()).not.toThrow();

    const sumGroup = m.registerSummaryGroup('sg');
    expect(() => sumGroup.observe({ a: 0.5 })).not.toThrow();
    expect(() => sumGroup.reset()).not.toThrow();

    // Tracing — passthrough, must return the same function reference.
    const fn = (x: number) => x * 2;
    expect(m.traceFunction('f', fn)).toBe(fn);
    expect(m.createTrace()).toBeUndefined();
  });

  it('trackMultiaddrConnection is a no-op (bytes are counted at the protocol-stream level)', () => {
    // Codex review on PR #525 + branarakic's finding: the previous
    // design counted bytes on /p2p-circuit MultiaddrConnections, but
    // those don't exist on the relay host — only on the edge
    // endpoints. Counting at the connection level was always
    // returning zero in production. The new design moves byte
    // counting onto trackProtocolStream + HOP/STOP codec filter, and
    // makes trackMultiaddrConnection a deliberate no-op so it can't
    // re-introduce zero-rate counters by mistake.
    const m = new RelayMetricsAdapter();
    expect(() => m.trackMultiaddrConnection({} as any)).not.toThrow();
    expect(m.snapshot().bytesIn).toBe(0n);
    expect(m.snapshot().bytesOut).toBe(0n);
    expect(m.snapshot().activeTracked).toBe(0);
    expect(m.snapshot().totalTracked).toBe(0);
  });
});

describe('RelayMetricsAdapter — trackProtocolStream (the real path)', () => {
  it('does not count bytes on non-relay protocol streams (DHT, gossipsub, identify)', () => {
    const m = new RelayMetricsAdapter();
    const dht = new FakeStream('/ipfs/kad/1.0.0', 'dht-1');
    m.trackProtocolStream(dht as any);

    dht.emitInbound(new Uint8Array(100));
    dht.send(new Uint8Array(200));

    expect(m.snapshot().bytesIn).toBe(0n);
    expect(m.snapshot().bytesOut).toBe(0n);
    expect(m.snapshot().activeTracked).toBe(0);
    expect(m.snapshot().totalTracked).toBe(0);
  });

  it('counts inbound bytes (message events) on HOP relay-server streams', () => {
    const m = new RelayMetricsAdapter();
    const hop = new FakeStream(RELAY_V2_HOP_CODEC, 'hop-1');
    m.trackProtocolStream(hop as any);

    expect(m.snapshot().activeTracked).toBe(1);
    expect(m.snapshot().totalTracked).toBe(1);

    hop.emitInbound(new Uint8Array(100));
    hop.emitInbound(new Uint8Array(200));
    hop.emitInbound(new Uint8Array(50));

    expect(m.snapshot().bytesIn).toBe(350n);
    expect(m.snapshot().bytesOut).toBe(0n);
  });

  it('counts outbound bytes (.send() wrapper) on STOP relay-server streams', () => {
    const m = new RelayMetricsAdapter();
    const stop = new FakeStream(RELAY_V2_STOP_CODEC, 'stop-1');
    m.trackProtocolStream(stop as any);

    const ok1 = stop.send(new Uint8Array(64));
    const ok2 = stop.send(new Uint8Array(128));

    // The wrapper preserves the original send's return value.
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
    // Outbound chunks reach the underlying send() unchanged.
    expect(stop.sentChunks).toHaveLength(2);
    expect(m.snapshot().bytesOut).toBe(192n);
    expect(m.snapshot().bytesIn).toBe(0n);
  });

  it('counts forwarded-circuit traffic across both HOP and STOP streams', () => {
    // Realistic relay forwarding scenario: dialer sends bytes via HOP
    // (inbound to relay), relay pipes them out via STOP (outbound
    // from relay), reservee replies via STOP (inbound), relay sends
    // back via HOP (outbound). Verifies bytesIn/bytesOut aggregate
    // both sides correctly, mirroring `pipe(src, dst, src)` semantics
    // in @libp2p/circuit-relay-v2/utils.ts.
    const m = new RelayMetricsAdapter();
    const hop = new FakeStream(RELAY_V2_HOP_CODEC, 'hop-1');
    const stop = new FakeStream(RELAY_V2_STOP_CODEC, 'stop-1');
    m.trackProtocolStream(hop as any);
    m.trackProtocolStream(stop as any);

    hop.emitInbound(new Uint8Array(1000));
    stop.send(new Uint8Array(1000));
    stop.emitInbound(new Uint8Array(500));
    hop.send(new Uint8Array(500));

    expect(m.snapshot().bytesIn).toBe(1500n);
    expect(m.snapshot().bytesOut).toBe(1500n);
    expect(m.snapshot().activeTracked).toBe(2);
    expect(m.snapshot().totalTracked).toBe(2);
  });

  it('decrements activeTracked on close (but keeps totalTracked = lifetime count)', () => {
    const m = new RelayMetricsAdapter();
    const hop = new FakeStream(RELAY_V2_HOP_CODEC);
    m.trackProtocolStream(hop as any);
    expect(m.snapshot().activeTracked).toBe(1);

    hop.emitClose();
    expect(m.snapshot().activeTracked).toBe(0);
    // totalTracked is a lifetime counter, never decremented.
    expect(m.snapshot().totalTracked).toBe(1);

    // Idempotent — a second close event must not double-decrement
    // activeTracked into negatives, otherwise repeated teardowns
    // would cause underflow.
    hop.emitClose();
    expect(m.snapshot().activeTracked).toBe(0);
  });

  it('stops counting inbound bytes after close (listener was removed)', () => {
    const m = new RelayMetricsAdapter();
    const stop = new FakeStream(RELAY_V2_STOP_CODEC);
    m.trackProtocolStream(stop as any);

    stop.emitInbound(new Uint8Array(10));
    expect(m.snapshot().bytesIn).toBe(10n);

    stop.emitClose();
    // Post-close inbound events must NOT inflate the counter — the
    // listener has been removed by the close handler.
    stop.emitInbound(new Uint8Array(100));
    expect(m.snapshot().bytesIn).toBe(10n);
  });

  it('handles Uint8ArrayList-style chunks via byteLength fallback', () => {
    const m = new RelayMetricsAdapter();
    const stream = new FakeStream(RELAY_V2_HOP_CODEC);
    m.trackProtocolStream(stream as any);

    // Sneak a Uint8ArrayList-shaped chunk through both surfaces.
    stream.emitInbound({ byteLength: 17 } as any);
    stream.send({ byteLength: 42 } as any);

    expect(m.snapshot().bytesIn).toBe(17n);
    expect(m.snapshot().bytesOut).toBe(42n);
  });

  it('snapshot() is independently readable as a plain object (not a live binding)', () => {
    const m = new RelayMetricsAdapter();
    const stream = new FakeStream(RELAY_V2_HOP_CODEC);
    m.trackProtocolStream(stream as any);
    const before: RelayBytesSnapshot = m.snapshot();
    stream.emitInbound(new Uint8Array(7));
    const after: RelayBytesSnapshot = m.snapshot();
    // Each snapshot is a fresh capture; before's bytesIn must NOT
    // mutate when the adapter increments its internal counter.
    expect(before.bytesIn).toBe(0n);
    expect(after.bytesIn).toBe(7n);
  });
});

describe('RelayMetricsAdapter — direction filter (PR #525 round-2 fix)', () => {
  it('does not count client-side HOP outbound (this node dialing through some other relay)', () => {
    // Reproduces the inflate-self-as-relay scenario branarakic flagged.
    // A node running the relay server AND configured with relayPeers
    // also opens HOP streams of its own (when dialing through another
    // relay). Those bytes must NOT be attributed to "traffic forwarded
    // by this relay".
    const m = new RelayMetricsAdapter();
    const clientHop = new FakeStream(RELAY_V2_HOP_CODEC, 'client-hop', 'outbound');
    m.trackProtocolStream(clientHop as any);

    clientHop.emitInbound(new Uint8Array(500));
    clientHop.send(new Uint8Array(800));

    expect(m.snapshot().bytesIn).toBe(0n);
    expect(m.snapshot().bytesOut).toBe(0n);
    expect(m.snapshot().activeTracked).toBe(0);
    expect(m.snapshot().totalTracked).toBe(0);
  });

  it('does not count client-side STOP inbound (this node IS the reservee receiving relayed bytes)', () => {
    // Mirror of the above: an edge node behind NAT receives forwarded
    // bytes via STOP streams (inbound). On a node that ALSO runs the
    // relay server (e.g. a core node that still falls back to network
    // relays), those bytes would otherwise be falsely counted as
    // "forwarded by this relay".
    const m = new RelayMetricsAdapter();
    const clientStop = new FakeStream(RELAY_V2_STOP_CODEC, 'client-stop', 'inbound');
    m.trackProtocolStream(clientStop as any);

    clientStop.emitInbound(new Uint8Array(500));
    clientStop.send(new Uint8Array(800));

    expect(m.snapshot().bytesIn).toBe(0n);
    expect(m.snapshot().bytesOut).toBe(0n);
    expect(m.snapshot().activeTracked).toBe(0);
    expect(m.snapshot().totalTracked).toBe(0);
  });

  it('counts only the server-side seam when both client + server streams are open simultaneously', () => {
    // Realistic mixed scenario: a core node is both a relay server
    // (forwarding bytes for others via HOP-in/STOP-out) AND a relay
    // client (dialing peers via HOP-out / receiving via STOP-in).
    // Only the server-side bytes should land in the snapshot.
    const m = new RelayMetricsAdapter();
    const serverHop = new FakeStream(RELAY_V2_HOP_CODEC, 'server-hop', 'inbound');
    const serverStop = new FakeStream(RELAY_V2_STOP_CODEC, 'server-stop', 'outbound');
    const clientHop = new FakeStream(RELAY_V2_HOP_CODEC, 'client-hop', 'outbound');
    const clientStop = new FakeStream(RELAY_V2_STOP_CODEC, 'client-stop', 'inbound');
    m.trackProtocolStream(serverHop as any);
    m.trackProtocolStream(serverStop as any);
    m.trackProtocolStream(clientHop as any);
    m.trackProtocolStream(clientStop as any);

    serverHop.emitInbound(new Uint8Array(100));
    serverStop.send(new Uint8Array(100));
    clientHop.emitInbound(new Uint8Array(9999));
    clientStop.send(new Uint8Array(9999));

    expect(m.snapshot().bytesIn).toBe(100n);
    expect(m.snapshot().bytesOut).toBe(100n);
    expect(m.snapshot().activeTracked).toBe(2);
    expect(m.snapshot().totalTracked).toBe(2);
  });
});

describe('RelayMetricsAdapter — bytesOut-after-send (PR #525 round-2 fix)', () => {
  it('does NOT increment bytesOut when send() throws synchronously', () => {
    // Codex review on PR #525: if .send() throws on a closed/broken
    // stream, the dashboard would otherwise count bytes that never
    // actually left the relay. The fix is to increment AFTER
    // delegated send returns successfully.
    const m = new RelayMetricsAdapter();
    const stop = new FakeStream(RELAY_V2_STOP_CODEC);
    stop.sendImpl = () => {
      throw new Error('stream is closed');
    };
    m.trackProtocolStream(stop as any);

    expect(() => stop.send(new Uint8Array(500))).toThrow('stream is closed');
    expect(m.snapshot().bytesOut).toBe(0n);
  });

  it('increments bytesOut only AFTER the awaited send promise resolves', async () => {
    // Some libp2p Stream impls return Promise<boolean>. The fix must
    // wait for that promise to resolve before incrementing — otherwise
    // a rejected send still inflates the counter.
    const m = new RelayMetricsAdapter();
    const stop = new FakeStream(RELAY_V2_STOP_CODEC);
    let resolveSend: (v: boolean) => void = () => {};
    stop.sendImpl = () => new Promise<boolean>((r) => { resolveSend = r; });
    m.trackProtocolStream(stop as any);

    const sendPromise = stop.send(new Uint8Array(750));
    // Pre-resolve: send is in-flight, counter must NOT have moved yet.
    expect(m.snapshot().bytesOut).toBe(0n);

    resolveSend(true);
    await sendPromise;

    expect(m.snapshot().bytesOut).toBe(750n);
  });

  it('does NOT increment bytesOut when an awaited send promise rejects', async () => {
    const m = new RelayMetricsAdapter();
    const stop = new FakeStream(RELAY_V2_STOP_CODEC);
    stop.sendImpl = () => Promise.reject(new Error('connection reset'));
    m.trackProtocolStream(stop as any);

    await expect(stop.send(new Uint8Array(750))).rejects.toThrow('connection reset');
    expect(m.snapshot().bytesOut).toBe(0n);
  });
});

describe('RelayMetricsAdapter — custom shouldTrack predicate (test override)', () => {
  it('counts bytes on non-relay protocol streams when shouldTrack returns true', () => {
    const m = new RelayMetricsAdapter(() => true);
    const dht = new FakeStream('/ipfs/kad/1.0.0');
    m.trackProtocolStream(dht as any);
    dht.emitInbound(new Uint8Array(99));
    expect(m.snapshot().bytesIn).toBe(99n);
  });

  it('skips all streams when shouldTrack returns false', () => {
    const m = new RelayMetricsAdapter(() => false);
    const stream = new FakeStream(RELAY_V2_STOP_CODEC);
    m.trackProtocolStream(stream as any);
    stream.emitInbound(new Uint8Array(99));
    expect(m.snapshot().bytesIn).toBe(0n);
    expect(m.snapshot().activeTracked).toBe(0);
  });
});
