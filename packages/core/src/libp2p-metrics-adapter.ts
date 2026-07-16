// libp2p-metrics-adapter.ts
//
// Minimal in-process implementation of @libp2p/interface's `Metrics`
// surface, scoped to ONE thing: counting bytes that flow through
// circuit-relay v2 forwarded traffic on a Core Node. We don't ship a
// full prom-client-style metrics stack here because the entire
// observability story for the dashboard already runs through
// MetricsCollector + DashboardDB; libp2p's Metrics interface just
// happens to be the only seam where forwarded byte counts are
// observable without forking the relay-server module.
//
// IMPORTANT — why we instrument PROTOCOL STREAMS, not MultiaddrConnections:
//
// On a circuit-relay v2 server, forwarded traffic does NOT flow over
// `/p2p-circuit` connections. The `/p2p-circuit` multiaddr only exists
// on the EDGE endpoints (dialer + reservee). On the relay host, the
// data path is two raw protocol streams piped together inside the
// relay-server module:
//
//   1. The dialer opens an inbound HOP stream to the relay over its
//      direct connection (protocol `/libp2p/circuit/relay/0.2.0/hop`).
//   2. The relay opens an outbound STOP stream to the reservee over
//      the reservee's direct connection (protocol
//      `/libp2p/circuit/relay/0.2.0/stop`).
//   3. `createLimitedRelay()` in `@libp2p/circuit-relay-v2/utils.ts`
//      then `pipe(src, dst, src)`s the two streams together.
//
// So a `MultiaddrConnection`-level filter for `/p2p-circuit` (the
// previous design) would always count zero on a relay server — the
// addr only ever shows up on the edge endpoints. To capture relay
// throughput we have to instrument at the protocol-stream level via
// `trackProtocolStream`, filtering for HOP+STOP codecs.
//
// Direction filter (server-only):
//   A node may run the relay server AND have its own `relayPeers`
//   configured (the daemon falls back to network relays unless
//   `relay: "none"`). Without filtering by `stream.direction`, the
//   client-side HOP/STOP streams (this node dialing through some
//   other relay, or being a reservee) would inflate the counters
//   even though no traffic was actually forwarded BY this relay.
//   So we filter:
//     - HOP inbound:  dialer → relay (the relay is receiving)
//     - STOP outbound: relay → reservee (the relay is initiating)
//   Anything else (HOP outbound, STOP inbound) is the client-side
//   surface and is dropped. See `isRelayServerStream` JSDoc for the
//   full direction-vs-protocol matrix.
//
// Caveats of stream-level counting:
//   - Each HOP/STOP stream carries a small protobuf control header
//     (RESERVE/CONNECT request + response) before any data flow. For
//     RESERVE-only HOP streams (no CONNECT), this is the ONLY traffic.
//     For CONNECT'd streams, the protobuf overhead is dwarfed by the
//     forwarded payload. Net effect: ~tens of bytes of inflation per
//     reservation lifecycle, which is in the noise floor of any
//     real-world Core Node serving forwarded chat / SWM gossip.
//   - bytesIn = aggregate of `'message'` events on tracked streams
//     (= bytes ARRIVING at the relay's HOP+STOP endpoints from the
//     remote dialer / reservee).
//   - bytesOut = aggregate of `.send()` calls on tracked streams,
//     incremented AFTER the delegated send returns (= bytes that
//     actually left the relay's HOP+STOP endpoints toward the remote
//     dialer / reservee). Counting before send() would double-count
//     chunks that fail on a closed stream — Codex review caught this
//     during PR #525.
//   In a healthy bidirectional circuit, bytesIn ≈ bytesOut: every
//   payload byte is `'message'`d on one side and `.send()`d on the
//   other after the pipe (`pipe(src, dst, src)`).
//
// Event-based design: libp2p 3.x Stream extends MessageStream — it
// dispatches `'message'` events for inbound data and exposes
// `.send(Uint8Array | Uint8ArrayList)` for outbound. (Older libp2p
// versions used duplex iterators with `source`/`sink` — that surface
// no longer exists in the version we ship.)

import type {
  Counter,
  CounterGroup,
  Histogram,
  HistogramGroup,
  Metric,
  MetricGroup,
  Metrics,
  MultiaddrConnection,
  Stream,
  StreamMessageEvent,
  Summary,
  SummaryGroup,
} from '@libp2p/interface';

/**
 * libp2p protocol codec for the relay HOP stream (dialer ↔ relay).
 * Pinned here so the build doesn't depend on the @libp2p/circuit-relay-v2
 * package's constants module just for two strings — the codec is part
 * of the wire-stable circuit-relay v2 spec, not an internal libp2p
 * implementation detail.
 */
export const RELAY_V2_HOP_CODEC = '/libp2p/circuit/relay/0.2.0/hop';
/** libp2p protocol codec for the relay STOP stream (relay ↔ reservee). */
export const RELAY_V2_STOP_CODEC = '/libp2p/circuit/relay/0.2.0/stop';

/** Live view of relay byte traffic this node has forwarded since startup. */
export interface RelayBytesSnapshot {
  /** Total bytes received via 'message' events on tracked streams. */
  bytesIn: bigint;
  /** Total bytes sent via .send() on tracked streams. */
  bytesOut: bigint;
  /** Streams currently being byte-counted (open + tracked). */
  activeTracked: number;
  /** Streams we have ever started tracking since startup. */
  totalTracked: number;
}

/**
 * Predicate for "is this stream the relay SERVER side of a HOP/STOP
 * stream we should count bytes for". On a Core Node these are the
 * only streams whose payload reflects forwarded relay traffic.
 *
 * Direction matters because a node may run the relay server AND have
 * its own `relayPeers` configured (the daemon falls back to network
 * relays for both core and edge unless explicitly disabled). Without
 * the direction filter, the client-side HOP/STOP streams (this node
 * dialing through another relay or being a reservee) would inflate
 * `bytesIn` / `bytesOut` even though no traffic was actually
 * "forwarded by this relay".
 *
 * Server-side semantics:
 *   - HOP inbound:  the dialer opened a HOP stream TO this relay
 *     (RESERVE or CONNECT request) — the relay receives it.
 *   - STOP outbound: this relay opened a STOP stream TO the reservee
 *     to push the dialer's bytes — the relay initiates it.
 *
 * Client-side (filtered out here):
 *   - HOP outbound: this node dialing through some other relay.
 *   - STOP inbound: this node IS the reservee receiving relayed
 *     traffic from some peer.
 *
 * Exposed for tests; production always uses this default.
 */
export function isRelayServerStream(stream: Stream): boolean {
  try {
    const protocol = stream.protocol;
    const direction = stream.direction;
    if (protocol === RELAY_V2_HOP_CODEC) return direction === 'inbound';
    if (protocol === RELAY_V2_STOP_CODEC) return direction === 'outbound';
    return false;
  } catch {
    return false;
  }
}

/**
 * Read the byte length of a chunk. libp2p chunks are
 * `Uint8Array | Uint8ArrayList` — both expose `byteLength`. The
 * `length` fallback is for defence-in-depth; production chunks
 * always have byteLength.
 */
function chunkByteLength(chunk: unknown): number {
  if (chunk == null) return 0;
  const c = chunk as { byteLength?: unknown; length?: unknown };
  if (typeof c.byteLength === 'number') return c.byteLength;
  if (typeof c.length === 'number') return c.length;
  return 0;
}

/** No-op metric — every register* method on the adapter returns one of these. */
const NOOP_METRIC: Metric = {
  update: () => {},
  increment: () => {},
  decrement: () => {},
  reset: () => {},
  timer: () => () => {},
};

const NOOP_METRIC_GROUP: MetricGroup = {
  update: () => {},
  increment: () => {},
  decrement: () => {},
  reset: () => {},
  timer: () => () => {},
};

const NOOP_COUNTER: Counter = {
  increment: () => {},
  reset: () => {},
};

const NOOP_COUNTER_GROUP: CounterGroup = {
  increment: () => {},
  reset: () => {},
};

const NOOP_HISTOGRAM: Histogram = {
  observe: () => {},
  reset: () => {},
  timer: () => () => {},
};

const NOOP_HISTOGRAM_GROUP: HistogramGroup = {
  observe: () => {},
  reset: () => {},
  timer: () => () => {},
};

const NOOP_SUMMARY: Summary = {
  observe: () => {},
  reset: () => {},
  timer: () => () => {},
};

const NOOP_SUMMARY_GROUP: SummaryGroup = {
  observe: () => {},
  reset: () => {},
  timer: () => () => {},
};

/**
 * Adapter implementing libp2p's `Metrics` interface with byte-counting
 * for circuit-relay v2 HOP+STOP streams only. All other Metrics
 * surface methods return no-op objects so libp2p starts cleanly
 * without us shipping a full prometheus-style stack.
 *
 * Production wires this to a relay-server's `metrics:` option in
 * `createLibp2p()`; the libp2p runtime then calls
 * `trackProtocolStream(stream)` on every newly opened protocol
 * stream — we filter for HOP+STOP codecs and instrument those.
 */
export class RelayMetricsAdapter implements Metrics {
  private bytesIn = 0n;
  private bytesOut = 0n;
  private activeTracked = 0;
  private totalTracked = 0;

  /**
   * Override predicate for tests. Production always uses
   * `isRelayServerStream`; tests can pass `() => true` to count
   * bytes on every stream without setting up a full circuit-relay
   * test rig.
   */
  constructor(
    private readonly shouldTrack: (stream: Stream) => boolean = isRelayServerStream,
  ) {}

  /** Snapshot of the byte counters; safe to call concurrently with traffic. */
  snapshot(): RelayBytesSnapshot {
    return {
      bytesIn: this.bytesIn,
      bytesOut: this.bytesOut,
      activeTracked: this.activeTracked,
      totalTracked: this.totalTracked,
    };
  }

  // ─── Metrics interface — the one method we actually instrument ─────

  trackProtocolStream(stream: Stream): void {
    if (!this.shouldTrack(stream)) return;
    this.activeTracked += 1;
    this.totalTracked += 1;

    // INBOUND: subscribe to the 'message' event. Each event's `.data`
    // is the chunk that just arrived from the remote peer. On the
    // relay's HOP stream this is bytes from the dialer; on the
    // STOP stream it's bytes from the reservee. Either way, an
    // arriving byte counts as bytesIn (relay-perspective).
    const onMessage = (evt: StreamMessageEvent) => {
      const n = chunkByteLength(evt.data);
      if (n > 0) this.bytesIn += BigInt(n);
    };
    stream.addEventListener('message', onMessage);

    // OUTBOUND: wrap .send() so every chunk that successfully leaves
    // the stream gets its byteLength added to the counter AFTER the
    // delegated send returns / resolves. Counting before send() would
    // double-count any chunk that throws on a closed/broken stream
    // (Codex review on PR #525) — the dashboard would show bytes
    // that were never actually forwarded.
    //
    // libp2p's .send() returns either `boolean` (sync, false ==
    // backpressure) or `Promise<boolean>` (some impls async). We handle
    // both: synchronous returns increment immediately; promises
    // increment in a `.then()` callback. Errors in either case skip
    // the increment.
    const originalSend = stream.send.bind(stream);
    stream.send = (data: any) => {
      const n = chunkByteLength(data);
      let result: any;
      try {
        result = originalSend(data);
      } catch (err) {
        throw err;
      }
      if (result && typeof result.then === 'function') {
        return result.then((v: boolean) => {
          if (n > 0) this.bytesOut += BigInt(n);
          return v;
        });
      }
      if (n > 0) this.bytesOut += BigInt(n);
      return result;
    };

    // CLOSE: on close, remove the message listener and decrement the
    // active counter. libp2p emits 'close' (sometimes 'remoteCloseWrite'
    // / 'remoteCloseRead' first) when the underlying stream tears down.
    let alreadyDecremented = false;
    const onClose = () => {
      if (alreadyDecremented) return;
      alreadyDecremented = true;
      this.activeTracked = Math.max(0, this.activeTracked - 1);
      stream.removeEventListener('message', onMessage);
      stream.removeEventListener('close', onClose as any);
    };
    stream.addEventListener('close', onClose as any);
  }

  // ─── Metrics interface — no-op stubs (we don't ship a full stack) ──

  trackMultiaddrConnection(_maConn: MultiaddrConnection): void {
    // Bytes are counted at the protocol-stream level via
    // trackProtocolStream — the only stream codecs we care about
    // (HOP/STOP) carry the relay's forwarded payload. Counting at
    // the connection level here would inflate the totals because
    // every MultiaddrConnection carries many non-relay streams
    // (DHT, gossipsub, ping, identify, …) and the actual relay
    // bytes are already accounted for by trackProtocolStream.
  }

  registerMetric(..._args: any[]): any { return NOOP_METRIC; }
  registerMetricGroup(..._args: any[]): any { return NOOP_METRIC_GROUP; }
  registerCounter(..._args: any[]): any { return NOOP_COUNTER; }
  registerCounterGroup(..._args: any[]): any { return NOOP_COUNTER_GROUP; }
  registerHistogram(..._args: any[]): any { return NOOP_HISTOGRAM; }
  registerHistogramGroup(..._args: any[]): any { return NOOP_HISTOGRAM_GROUP; }
  registerSummary(..._args: any[]): any { return NOOP_SUMMARY; }
  registerSummaryGroup(..._args: any[]): any { return NOOP_SUMMARY_GROUP; }

  traceFunction<F extends (...args: any[]) => any>(_name: string, fn: F): F {
    // Tracing is a no-op — return the function unwrapped. libp2p's
    // built-in metrics module wraps functions for OTEL spans; since
    // we don't ship OTEL plumbing, the unwrapped passthrough is the
    // correct semantic.
    return fn;
  }

  createTrace(): any {
    return undefined;
  }
}
