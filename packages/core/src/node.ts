import { createLibp2p, type Libp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webSockets } from '@libp2p/websockets';
import { noise } from '@libp2p/noise';
import { yamux } from '@libp2p/yamux';
import { bootstrap } from '@libp2p/bootstrap';
import { kadDHT, type KadDHT } from '@libp2p/kad-dht';
import { gossipsub, type GossipSub } from '@libp2p/gossipsub';
import { mdns } from '@libp2p/mdns';
import { identify, identifyPush, type IdentifyPush } from '@libp2p/identify';
import { ping, type Ping } from '@libp2p/ping';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { autoNAT } from '@libp2p/autonat';
import type { ConnectionGater } from '@libp2p/interface';
import { generateKeyPair, privateKeyFromRaw } from '@libp2p/crypto/keys';
import { peerIdFromString, peerIdFromPrivateKey } from '@libp2p/peer-id';
import { ed25519GetPublicKey } from './crypto/ed25519.js';
import type { ConnectionTransport, DKGNodeConfig } from './types.js';
import { DKG_GOSSIP_MAX_RPC_BYTES, dhtProtocolForNetwork } from './constants.js';
import { POOLED_MESSAGE_PROTOCOL } from './message-stream-pool.js';
import { RelayMetricsAdapter, RELAY_V2_STOP_CODEC } from './libp2p-metrics-adapter.js';
import { readRelayReservations, readConnectionStreams } from './relay-internal-shapes.js';
import { RelayFlapGuard, buildRelayFlapConnectionGater } from './relay-flap-guard.js';
import { buildActiveRelayNetworkPolicy } from './relay-network-policy.js';
import { parseCircuitRelayPeerIds, type RelayedConnectionGater } from './relay-path.js';

export interface DKGServices extends Record<string, unknown> {
  dht: KadDHT;
  pubsub: GossipSub;
  identify: unknown;
  identifyPush: IdentifyPush;
  ping: Ping;
  dcutr: unknown;
  autoNAT?: unknown;
  relay?: unknown;
}

const RELAY_WATCHDOG_BASE_INTERVAL_MS = 10_000;
const RELAY_WATCHDOG_MAX_INTERVAL_MS = 5 * 60_000;
/** Short delay before redialing a disconnected relay to avoid hammering (ms). */
const RELAY_REDIAL_DELAY_MS = 1_500;
/**
 * How long to allow a fresh reservation negotiation to complete after a relay
 * redial before the watchdog considers the relay unhealthy again. Circuit
 * Relay v2 reservation setup is usually sub-second on a healthy link, but we
 * give it a generous grace window to absorb transient latency.
 */
const RELAY_RESERVATION_GRACE_MS = 15_000;

/**
 * Protocol prefixes whose in-flight streams mark a relay connection "busy"
 * for the watchdog's forced reservation-redial: application request/response
 * exchanges (StorageACK collection, durable sync, verify fan-out, …) that an
 * abrupt `close()` aborts mid-flight. 2026-07-12 testnet outage: a NAT'd
 * edge's watchdog severed its relay-target connections every grace-window
 * expiry while the bootstraps' reservation slots were exhausted — and the
 * relay targets doubled as the publish quorum's ACK cores, so every burst
 * publish lost its ACK streams (same failure shape as the 2026-07-07 Gnosis
 * incident documented on `nodeIsPubliclyReachable` below, but on NAT'd nodes
 * where that bypass can't apply).
 *
 * Long-lived infrastructure streams (gossipsub mesh, identify, ping, dcutr,
 * circuit hop/stop) are deliberately NOT counted: they sit open on virtually
 * every connection, so counting them would defer reservation recovery
 * forever.
 */
export const WATCHDOG_BUSY_PROTOCOL_PREFIXES = ['/dkg/'] as const;

/**
 * `/dkg/`-prefixed protocols that are NOT request/response exchanges and must
 * not defer the forced redial (adversarial review of this fix, round 1):
 * - The pooled message wire stream (`/dkg/10.0.2/message`) is deliberately
 *   immortal — 10s keepalive PINGs re-arm its idle timer — so its existence
 *   ≠ in-flight work, and severing it is recoverable by design
 *   (PooledStreamResetError → outbox retry → stream reopens on next send).
 * - DKG namespaces its Kademlia DHT under `/dkg/[…/]kad/1.0.0`; DHT RPCs are
 *   ambient infrastructure whose abort the query layer routes around.
 */
export function isWatchdogBusyProtocol(protocol: string): boolean {
  if (!WATCHDOG_BUSY_PROTOCOL_PREFIXES.some((prefix) => protocol.startsWith(prefix))) return false;
  if (protocol === POOLED_MESSAGE_PROTOCOL) return false;
  if (protocol.includes('/kad/')) return false;
  return true;
}

/**
 * Distinct busy app protocols across a peer's connections (see
 * isWatchdogBusyProtocol). Stream access goes through
 * `readConnectionStreams` — the one place that owns libp2p's
 * not-quite-public `connection.streams` shape. Exported for tests.
 */
export function connectionsBusyAppProtocols(conns: readonly unknown[]): string[] {
  const busy = new Set<string>();
  for (const conn of conns) {
    for (const stream of readConnectionStreams(conn) ?? []) {
      const protocol = stream.protocol;
      if (protocol && isWatchdogBusyProtocol(protocol)) {
        busy.add(protocol);
      }
    }
  }
  return [...busy];
}

/**
 * Best-effort reset of busy application streams before the relay watchdog
 * closes their transport. Stream discovery stays behind
 * `readConnectionStreams`, because libp2p may temporarily expose a missing
 * stream array or an incompletely negotiated stream during teardown.
 * Returns the number of distinct streams whose abort function was invoked.
 */
export function abortWatchdogBusyStreams(
  conns: readonly unknown[],
  reason: Error,
): number {
  const reaped = new Set<unknown>();
  let aborted = 0;
  for (const connection of conns) {
    for (const stream of readConnectionStreams(connection) ?? []) {
      if (reaped.has(stream)) continue;
      const { protocol, abort } = stream;
      if (typeof protocol !== 'string'
        || !isWatchdogBusyProtocol(protocol)
        || typeof abort !== 'function') {
        continue;
      }
      reaped.add(stream);
      try {
        abort.call(stream, reason);
        aborted += 1;
      } catch {
        // Best-effort; connection teardown remains the final reaper.
      }
    }
  }
  return aborted;
}

/**
 * Per-relay forced-redial bookkeeping (one object per relay instead of
 * parallel maps, so the invariants live in one place): `strikes` counts
 * consecutive futile forced redials, `cooldownUntil` suppresses the forced
 * path after the strike cap, `busyDeferralTicks` counts consecutive
 * busy-stream deferrals toward RELAY_BUSY_DEFERRAL_MAX_TICKS. The whole
 * entry is dropped the moment the relay's reservation gate is satisfied,
 * and the whole map is cleared on node stop (state must not leak into a
 * restarted node's fresh connections).
 */
interface RelayForcedRedialState {
  strikes: number;
  cooldownUntil: number;
  busyDeferralTicks: number;
}

/**
 * Consecutive busy-deferrals per relay before the forced redial proceeds
 * anyway. Bounds the liveness cost of the deferral: ANY long-lived or leaked
 * half-open `/dkg/` stream (current or future) can only DELAY reservation
 * recovery — never permanently disable it (~30 ticks ≈ 5 min at the base
 * interval). The teardown that then proceeds also doubles as the reaper for
 * stuck streams the deferral would otherwise preserve forever.
 */
const RELAY_BUSY_DEFERRAL_MAX_TICKS = 30;

/**
 * Consecutive forced reservation-redials against the same relay that failed
 * to yield a reservation before that relay's forced path is put on cooldown.
 * Tonight's outage shape: both configured relays' slots were exhausted, so
 * every forced drop+redial was guaranteed futile — and permanent (measured:
 * one relay torn down 95× in 2h). Strikes convert "futile forever" into
 * "5 attempts, then leave the connection alone for the cooldown window".
 * The regular reconnect-on-disconnect path is unaffected.
 */
const RELAY_FORCED_REDIAL_MAX_STRIKES = 5;
const RELAY_FORCED_REDIAL_COOLDOWN_MS = 10 * 60_000;

/**
 * Default relay server capacity — the number of simultaneous circuit-relay v2
 * reservations a Core Node will hold. All other relay-related caps (HOP/STOP
 * stream limits, connectionManager.maxConnections) derive from this at a 1:2
 * ratio so capacity=1024 → 2048 stream caps + 2048 max conns.
 *
 * Bumped from the previous hardcoded 256 (libp2p's stock default for the
 * relay-v2 server is even lower — 15) which capped a single Core Node at
 * ~256 concurrent edge agents. That was below the natural hundreds-to-
 * thousands-of-agents trajectory the network is designed for; PR #510's
 * agent-debug-chat exercised this directly and showed the cap was already
 * a meaningful ceiling at ~5 active edges. See operator docs for the
 * `ulimit -n` requirement.
 */
export const DEFAULT_RELAY_SERVER_CAPACITY = 1024;
/** Multiplier for derived stream + connection caps (capacity × 2). */
export const RELAY_CAPACITY_MULTIPLIER = 2;
/**
 * Per-circuit duration limit. Bumped from libp2p's 5-minute default to 30
 * minutes so chat-style intermittent traffic (5-15 minute silent gaps are
 * normal) doesn't tear circuits down underneath the application — this was
 * the proximate cause of the May 2026 NO_RESERVATION blackout pair (Miles
 * ↔ Lex) that motivated PRs #517, #521, and this one. Reservation TTL
 * itself stays at the libp2p default (2h) but is set explicitly below for
 * operator visibility.
 */
export const RELAY_DEFAULT_DURATION_LIMIT_MS = 30 * 60 * 1000;
export const RELAY_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;
/** maxConnections for nodes that don't run a relay server (edge default). */
export const EDGE_NODE_MAX_CONNECTIONS = 500;

/**
 * Default number of relay reservations an edge node tries to hold
 * simultaneously. The previous default (1) was a single point of failure:
 * if the only reserved relay went unreachable, the edge dropped off the
 * network until the watchdog redialed and re-reserved. Holding 3 in
 * parallel gives N-2 tolerance — two relays can blink concurrently and
 * incoming dialers can still find a working circuit.
 *
 * Implementation: each `/p2p-circuit` listen address triggers a separate
 * reservation slot in libp2p's transport reservation store, so the
 * config translates to N duplicate `/p2p-circuit` entries in the
 * libp2p `addresses.listen` array, paired with `reservationConcurrency:
 * N` on the circuit-relay transport so they're attempted in parallel.
 *
 * NOTE: libp2p auto-renews each reservation 5 minutes before expiry
 * (REFRESH_TIMEOUT in @libp2p/circuit-relay-v2/transport/reservation-store.js),
 * so no application-level proactive renewal is needed in our watchdog.
 * The watchdog still handles the harder failure mode of a fully-dropped
 * relay connection, which auto-renewal can't recover from.
 */
export const DEFAULT_RELAY_RESERVATION_COUNT = 3;
/**
 * Hard cap on `relayReservationCount` to keep operators from accidentally
 * configuring an edge node to hammer the network. Reserving on more than
 * ~16 relays at a time is a smell — it costs memory + control-stream
 * keepalive on every reserved relay, and the marginal failure-tolerance
 * benefit past 4-5 is minimal.
 */
export const MAX_RELAY_RESERVATION_COUNT = 16;

/**
 * Permissive validator for the small / sparse-network tunables
 * (`peerStoreMaxAddressAgeMs`, `peerStoreMaxPeerAgeMs`,
 * `dhtQuerySelfIntervalMs`). Returns the
 * value when it is a positive finite integer; returns `undefined`
 * otherwise so callers can fall through to the upstream default
 * silently. Unlike `validateRelayServerCapacity` these knobs are
 * passed straight to libp2p / kad-DHT code that already validates
 * its own input — we just defend against the obviously-wrong values
 * (0, negative, NaN, fractional, non-numeric) without taking on a
 * warning surface.
 */
export function isFinitePositiveInteger(input: unknown): input is number {
  return (
    typeof input === 'number' &&
    Number.isFinite(input) &&
    Number.isInteger(input) &&
    input > 0
  );
}

/**
 * The three small / sparse-network tunables we forward end-to-end
 * (`DkgConfig.network` → `DKGAgentConfig` → `DKGNodeConfig` →
 * `createLibp2p` / `kadDHT`). Centralising the field list as a single
 * named type means the forwarding hops cannot drift — `pickNetworkTunables`
 * below is the one chokepoint they all travel through, and its return
 * type is pinned to this interface so a missing / typo'd field in any
 * forwarder fails at compile time. Codex review of PR #698 round 3.
 */
export interface NetworkTunables {
  peerStoreMaxAddressAgeMs?: number;
  peerStoreMaxPeerAgeMs?: number;
  dhtQuerySelfIntervalMs?: number;
}

/**
 * Forward exactly the three operator-tunable network fields. Used at
 * every hop along `DkgConfig.network` → `DKGAgentConfig` →
 * `DKGNodeConfig`, so the mapping (and any future addition to
 * `NetworkTunables`) lives in exactly one place.
 *
 * The explicit field-by-field assignment is intentional: it guarantees
 * (via the `NetworkTunables` return type) that a typo at any caller
 * would fail to compile, and the value-preserving test in
 * `libp2p-tunables-wiring.test.ts` catches copy-paste-cross bugs
 * (e.g. wiring `peerStoreMaxAddressAgeMs ← source.peerStoreMaxPeerAgeMs`).
 * Round-2 tests fence the lowest layer (`buildPeerStoreOverrides` /
 * `buildKadDHTOptions`); this helper + its test fence the two
 * forwarding hops above that. Codex review of PR #698 round 3.
 */
export function pickNetworkTunables(
  source: Partial<NetworkTunables>,
): NetworkTunables {
  return {
    peerStoreMaxAddressAgeMs: source.peerStoreMaxAddressAgeMs,
    peerStoreMaxPeerAgeMs: source.peerStoreMaxPeerAgeMs,
    dhtQuerySelfIntervalMs: source.dhtQuerySelfIntervalMs,
  };
}

/**
 * Pure builder for the libp2p `peerStore` overrides we forward into
 * `createLibp2p`. Returns `undefined` when no operator field is valid
 * (the canonical signal for "omit the option block entirely so libp2p
 * keeps every upstream default"), otherwise returns an object whose
 * shape mirrors `@libp2p/peer-store`'s `PersistentPeerStoreInit`.
 *
 * Extracted from `DKGNode.start()` so a regression test can assert the
 * wiring without having to spin up a real libp2p node — Codex review
 * of PR #698 round 2 flagged that the previous test suite only
 * verified JSON persistence, so a typo in `maxAddressAge` /
 * `maxPeerAge` would ship as a silent no-op while the existing tests
 * still passed.
 */
export function buildPeerStoreOverrides(
  config: Pick<DKGNodeConfig, 'peerStoreMaxAddressAgeMs' | 'peerStoreMaxPeerAgeMs'>,
): { maxAddressAge?: number; maxPeerAge?: number } | undefined {
  const maxAddressAge = isFinitePositiveInteger(config.peerStoreMaxAddressAgeMs)
    ? config.peerStoreMaxAddressAgeMs
    : undefined;
  const maxPeerAge = isFinitePositiveInteger(config.peerStoreMaxPeerAgeMs)
    ? config.peerStoreMaxPeerAgeMs
    : undefined;
  if (maxAddressAge === undefined && maxPeerAge === undefined) return undefined;
  const out: { maxAddressAge?: number; maxPeerAge?: number } = {};
  if (maxAddressAge !== undefined) out.maxAddressAge = maxAddressAge;
  if (maxPeerAge !== undefined) out.maxPeerAge = maxPeerAge;
  return out;
}

/**
 * Pure builder for the `kadDHT()` init object. Always includes the
 * `protocol` (the daemon never wants the upstream default protocol
 * string); adds `querySelfInterval` only when operator config supplies
 * a positive finite integer.
 *
 * Extracted so the wiring is unit-testable without spinning up a real
 * libp2p — Codex review of PR #698 round 2 flagged the same silent-
 * no-op risk as `buildPeerStoreOverrides` above.
 */
export function buildKadDHTOptions(
  config: Pick<DKGNodeConfig, 'dhtQuerySelfIntervalMs'>,
  protocol: string,
): { protocol: string; querySelfInterval?: number } {
  const querySelfInterval = isFinitePositiveInteger(config.dhtQuerySelfIntervalMs)
    ? config.dhtQuerySelfIntervalMs
    : undefined;
  return querySelfInterval !== undefined
    ? { protocol, querySelfInterval }
    : { protocol };
}

/**
 * Validate an operator-supplied `relayReservationCount`. Same shape +
 * defensive surface as `validateRelayServerCapacity` (rejects 0,
 * negatives, NaN, Infinity, fractional, non-numbers). Additionally
 * caps at `MAX_RELAY_RESERVATION_COUNT` to avoid the
 * everyone-reserves-on-everyone failure mode on large networks.
 */
export type RelayReservationCountValidation =
  | { ok: true; value: number }
  | { ok: false; reason: string };
export function validateRelayReservationCount(
  input: unknown,
): RelayReservationCountValidation | null {
  if (input == null) return null;
  if (typeof input !== 'number') {
    return { ok: false, reason: `expected number, got ${typeof input}` };
  }
  if (!Number.isFinite(input)) {
    return { ok: false, reason: `expected finite number, got ${input}` };
  }
  if (!Number.isInteger(input)) {
    return { ok: false, reason: `expected integer, got ${input}` };
  }
  if (input < 1) {
    return { ok: false, reason: `expected >= 1, got ${input}` };
  }
  if (input > MAX_RELAY_RESERVATION_COUNT) {
    return {
      ok: false,
      reason: `expected <= ${MAX_RELAY_RESERVATION_COUNT}, got ${input}`,
    };
  }
  return { ok: true, value: input };
}

export interface DerivedRelayCaps {
  maxReservations: number;
  maxConnections: number;
  maxInboundHopStreams: number;
  maxOutboundHopStreams: number;
  maxOutboundStopStreams: number;
  maxInboundStopStreams: number;
}

/**
 * Validate an operator-supplied `relayServerCapacity` value. Capacity comes
 * from external config (config.json, env, etc.) so this defends against
 * `0`, negatives, NaN, Infinity, fractional values, non-numbers, and empty
 * strings — any of which would silently produce invalid limits or libp2p
 * startup failures (a `0` capacity, for instance, would cap streams /
 * connections at 0 and brick the relay; a fractional value would propagate
 * into libp2p's `maxConnections` which expects an integer).
 *
 * Returns `null` when the input is unset (so callers can apply their own
 * default). Returns an `{ ok: false }` verdict with a human-readable
 * reason for invalid input — the caller (start()) downgrades to the
 * default and emits an operator-facing warning.
 */
export type RelayCapacityValidation =
  | { ok: true; value: number }
  | { ok: false; reason: string };
/**
 * Largest `relayServerCapacity` that keeps every derived cap within
 * JavaScript's safe-integer range. `deriveRelayCaps` produces values up
 * to `capacity * RELAY_CAPACITY_MULTIPLIER` and feeds them straight to
 * libp2p config, so the safe ceiling is `MAX_SAFE_INTEGER /
 * RELAY_CAPACITY_MULTIPLIER`. Operator-supplied values above this would
 * silently lose precision when scaled (Codex review on PR #524 round 4
 * — the previous `Number.isInteger` check accepts e.g.
 * `9007199254740993` which fails round-trip equality with itself).
 */
export const MAX_RELAY_SERVER_CAPACITY = Math.floor(Number.MAX_SAFE_INTEGER / RELAY_CAPACITY_MULTIPLIER);
export function validateRelayServerCapacity(input: unknown): RelayCapacityValidation | null {
  if (input == null) return null;
  if (typeof input !== 'number') {
    return { ok: false, reason: `expected number, got ${typeof input}` };
  }
  if (!Number.isFinite(input)) {
    return { ok: false, reason: `expected finite number, got ${input}` };
  }
  // `isSafeInteger` instead of `isInteger` — the latter accepts values
  // above 2^53 that have already lost their integer identity (e.g.
  // `9007199254740993 === 9007199254740992`), which would corrupt the
  // multiplied caps `deriveRelayCaps` hands to libp2p.
  if (!Number.isSafeInteger(input)) {
    return { ok: false, reason: `expected safe integer, got ${input}` };
  }
  if (input < 1) {
    return { ok: false, reason: `expected >= 1, got ${input}` };
  }
  if (input > MAX_RELAY_SERVER_CAPACITY) {
    return {
      ok: false,
      reason: `expected <= ${MAX_RELAY_SERVER_CAPACITY} (so capacity × ${RELAY_CAPACITY_MULTIPLIER} stays a safe integer), got ${input}`,
    };
  }
  return { ok: true, value: input };
}

/**
 * Derive the full relay-related cap set from a single capacity value. The
 * 1:2 ratio is intentional: each reservation costs one long-lived control
 * connection, plus circuits going through this relay open additional
 * HOP+STOP streams (multiplexed) and other peers can connect for non-relay
 * reasons (DHT, gossip, direct dials). Doubling the capacity for streams
 * and connections gives realistic headroom without overcommitting.
 *
 * Throws on invalid input (non-finite, non-integer, < 1) — `start()`
 * gates this with `validateRelayServerCapacity()` so the throw is purely
 * a defensive backstop for direct callers.
 */
export function deriveRelayCaps(capacity: number): DerivedRelayCaps {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > MAX_RELAY_SERVER_CAPACITY) {
    throw new TypeError(
      `deriveRelayCaps: capacity must be a safe positive integer ` +
        `<= ${MAX_RELAY_SERVER_CAPACITY}, got ${capacity}`,
    );
  }
  const streamCap = capacity * RELAY_CAPACITY_MULTIPLIER;
  return {
    maxReservations: capacity,
    maxConnections: streamCap,
    maxInboundHopStreams: streamCap,
    maxOutboundHopStreams: streamCap,
    maxOutboundStopStreams: streamCap,
    maxInboundStopStreams: streamCap,
  };
}

/**
 * Severity of a `checkFdLimit` log emission. The "ok" path is
 * deliberately `info` — emitting it via `console.warn` would make the
 * level unreliable for operator alerting (every healthy startup would
 * trip warning-level filters). Only the under-provisioned and
 * unreadable-limit paths are `warn`.
 */
export type FdLimitLogLevel = 'info' | 'warn';

/**
 * Emit an informational/warning log at relay startup about the host's
 * `ulimit -n` (RLIMIT_NOFILE) versus what the configured maxConnections
 * actually needs. We can read this losslessly from
 * `process.report.getReport().userLimits.open_files` on POSIX (libp2p
 * Core Nodes are POSIX-only in practice).
 *
 * Why this matters: libp2p's maxConnections is an upper bound libp2p
 * tracks internally; if the kernel rejects the underlying socket() with
 * EMFILE before libp2p hits its own cap, the only signal is opaque
 * "peer rejected" errors in logs. Surfacing the discrepancy at startup
 * gives operators a loud, actionable signal.
 *
 * The callback receives `(level, msg)` so consumers can route each
 * emission to the appropriate logger sink (info vs warn). Mapping the
 * "ok" line to `info` keeps the warn channel meaningful for alerting.
 */
export function checkFdLimit(
  maxConnections: number,
  log: (level: FdLimitLogLevel, msg: string) => void,
): void {
  const recommended = Math.max(4096, maxConnections * RELAY_CAPACITY_MULTIPLIER);
  try {
    const report = (process as any).report?.getReport?.();
    const openFiles = report?.userLimits?.open_files;
    const soft = openFiles?.soft;
    if (typeof soft === 'number') {
      if (soft < recommended) {
        log(
          'warn',
          `relay server enabled with maxConnections=${maxConnections}, ` +
            `but host ulimit -n soft=${soft} is below the recommended ${recommended} ` +
            `(= max(4096, maxConnections × 2)). The kernel will reject new ` +
            `socket() calls with EMFILE once the daemon hits the limit, ` +
            `manifesting as silent peer rejections. Bump with ` +
            `'ulimit -n ${recommended}' (shell), 'LimitNOFILE=${recommended}' (systemd unit), ` +
            `or '--ulimit nofile=${recommended}:${recommended}' (Docker).`,
        );
      } else {
        log(
          'info',
          `relay server: ulimit -n soft=${soft} >= recommended ${recommended}, ok`,
        );
      }
    } else {
      log(
        'warn',
        `relay server: could not read host ulimit -n via process.report.userLimits; ` +
          `ensure ulimit -n >= ${recommended} on this host`,
      );
    }
  } catch (err: any) {
    log(
      'warn',
      `relay server: error reading ulimit -n (${err?.message ?? String(err)}); ` +
        `ensure ulimit -n >= ${recommended} on this host`,
    );
  }
}

interface RelayTarget {
  peerId: ReturnType<typeof peerIdFromString>;
  /**
   * All multiaddrs supplied for this relay peer. A config like
   * `[relayA-tcp, relayA-ws]` (same peerId, different transports)
   * collapses to one `RelayTarget` whose `addrs` holds both — libp2p
   * tries each in order so a stale address doesn't take the relay
   * out of rotation. Codex PR #526 round 5c caught the round-5
   * regression where same-peerId entries were dropped as duplicates.
   */
  addrs: any[];
}

/**
 * Conservative classifier matching `isMultiaddrRemotelyDialable` in
 * `packages/node-ui/src/ui/components/Modals/ShareProjectModal.tsx`.
 * Returns true for addresses a remote peer could plausibly dial without
 * traversing a circuit relay (i.e. global IPv4 / IPv6 / DNS-based).
 * Circuit-relay addresses are checked separately by callers because the
 * "peer record is dialable" signal merges both classes.
 */
export function isLocalOrInternalHostname(host: string): boolean {
  if (typeof host !== 'string' || host.length === 0) return true;
  const h = host.toLowerCase();
  if (h === 'localhost') return true;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (h.endsWith('.test') || h.endsWith('.example')) return true;
  if (h.endsWith('.invalid') || h.endsWith('.localdomain')) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true;
  if (/^\[?[0-9a-f:]+\]?$/.test(h) && h.includes(':')) return true;
  if (!h.includes('.')) return true;
  return false;
}

export function isPublicLikeAddress(addr: string): boolean {
  const dnsMatch = addr.match(/^\/(?:dns|dns4|dns6|dnsaddr)\/([^/]+)\//);
  if (dnsMatch) return !isLocalOrInternalHostname(dnsMatch[1]);
  const ipv4 = addr.match(/^\/ip4\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\//);
  if (ipv4) {
    const o = ipv4[1].split('.').map(Number);
    if (o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
    if (o[0] === 0 || o[0] === 127) return false;
    if (o[0] === 10) return false;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return false;
    if (o[0] === 192 && o[1] === 168) return false;
    if (o[0] === 169 && o[1] === 254) return false;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return false;
    if (o[0] >= 224) return false;
    return true;
  }
  const ipv6 = addr.match(/^\/ip6\/([^/]+)\//);
  if (ipv6) {
    const ip = ipv6[1].toLowerCase();
    if (ip === '::' || ip === '::1') return false;
    if (ip.startsWith('fe80')) return false;
    if (/^f[cd]/.test(ip)) return false;
    if (ip.startsWith('ff')) return false;
    return true;
  }
  return false;
}

/**
 * True when the node advertises at least one DIRECT (non-circuit) public
 * self-address — i.e. peers can dial it without a relay hop. Such a node does
 * not need client-side circuit reservations, so the relay watchdog must not
 * `close()` + redial relay-target connections trying to force one it will
 * never obtain (the 2026-07-07 Gnosis mainnet ACK-stream churn). A `/p2p-circuit`
 * self-address is proof of the OPPOSITE — reachability THROUGH a relay — so it
 * is explicitly excluded here.
 */
export function nodeHasDirectPublicAddress(selfAddrs: readonly string[]): boolean {
  return selfAddrs.some(
    (a) =>
      !a.includes('/p2p-circuit') &&
      // A /dnsaddr is a POINTER, not a transport: its TXT records may resolve
      // to circuit-only or private addresses, so announcing one is no proof of
      // direct dialability — treating it as direct would let a NAT'd node skip
      // reservation recovery and silently lose relay reachability. Concrete
      // transports (/ip4, /ip6, /dns4, /dns6 + port) remain valid evidence.
      !a.startsWith('/dnsaddr/') &&
      isPublicLikeAddress(a),
  );
}

export class DKGNode {
  private node: Libp2p<DKGServices> | null = null;
  private readonly config: DKGNodeConfig;
  /** Peers currently connected only via relay (candidates for DCUtR upgrade). */
  private readonly relayedPeers = new Set<string>();
  private readonly relayFlapGuard = new RelayFlapGuard();
  private relayWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private relayTargets: RelayTarget[] = [];
  private relayWatchdogConsecutiveFailures = 0;
  /**
   * Per-relay timestamp of the last redial we issued specifically because the
   * circuit reservation had lapsed. Used to suppress spurious "reservation
   * missing" findings while a freshly re-dialed relay is still negotiating
   * the new reservation on the wire.
   */
  private relayReservationRedialAt: Map<string, number> = new Map();
  /** Per-relay forced-redial bookkeeping; see RelayForcedRedialState. */
  private relayForcedRedialState: Map<string, RelayForcedRedialState> = new Map();
  /**
   * Target number of simultaneous relay reservations for this edge node
   * (1 by default, up to `relayReservationCount` for multi-reservation
   * edges from PR #526). The watchdog uses this to decide whether the
   * "any /p2p-circuit self-addr exists" healthy gate is sufficient
   * (target=1) or whether per-relay reservation presence must be
   * verified (target>1, otherwise N-1 reservations silently degrade
   * to N-1 forever — Codex review on PR #526).
   */
  private relayReservationCountTarget = 1;
  /**
   * In-process libp2p Metrics adapter. Instantiated only when this node
   * runs a relay server (`enableRelay` true) — its sole job is counting
   * bytes that flow through `/p2p-circuit` forwarded connections so the
   * dashboard can surface "actual relay traffic served" alongside the
   * static reservation count. Null on edge nodes; `getRelayStats()`
   * returns null in that case.
   */
  private relayMetrics: RelayMetricsAdapter | null = null;
  /**
   * Cached value of `relayServerCapacity` after defaulting + role-gating
   * applied by `start()`. Exposed via `getRelayStats()` so consumers can
   * compute utilization (reservationCount / capacity) without re-reading
   * the config.
   */
  private relayCapacity: number | null = null;
  /**
   * AbortController whose signal is wired into long-await sites
   * (currently: `ProtocolRouter.readAll` via `stopSignal` below). PR-6:
   * `stop()` aborts this controller as its FIRST action, before
   * `libp2p.stop()`, so any in-flight stream read can bail out
   * immediately rather than wedge on a silent peer / dead relay.
   *
   * `null` before `start()` and after `stop()` finishes, so callers
   * must always read via the `stopSignal` getter (returns `undefined`
   * when the node isn't started, which downstream code treats as
   * "no abort wiring available — fall back to whatever per-call
   * timeout was supplied").
   */
  private stopAbortController: AbortController | null = null;

  /**
   * Public AbortSignal that fires as the first step of `stop()`.
   * Consumers (notably `ProtocolRouter`) compose this with their own
   * per-call signals via AbortSignal.any so a graceful shutdown
   * cancels every in-flight network read.
   *
   * Returns `undefined` before `start()` and after `stop()` completes
   * — guard for "node-stopped" cases at the call site rather than
   * fabricating a never-aborts signal here.
   */
  get stopSignal(): AbortSignal | undefined {
    return this.stopAbortController?.signal;
  }

  constructor(config: DKGNodeConfig = {}) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.node) return;
    // PR-6: fresh AbortController per completed start cycle. Create it
    // locally and publish it only after libp2p exists; otherwise a startup
    // failure before `this.node` is set would leave callers composing against
    // a stale stopSignal that stop() cannot clear.
    const startStopAbortController = new AbortController();

    // Reset sticky relay state so a node restarted with a different
    // role / capacity doesn't leak the previous run's adapter or
    // capacity number into getRelayStats(). Codex review on PR #525
    // flagged that without this guard, restarting a `nodeRole: 'core'`
    // instance as edge would still inject the old metrics adapter
    // and report the prior capacity. Cheap to do unconditionally
    // since these fields are populated below only when relay /
    // multi-reservation is enabled.
    this.relayMetrics = null;
    this.relayCapacity = null;
    this.relayReservationCountTarget = 1;

    let privateKey;
    if (this.config.privateKey) {
      // privateKeyFromRaw needs 64 bytes for Ed25519: seed(32) + publicKey(32)
      const seed = this.config.privateKey;
      const pub = await ed25519GetPublicKey(seed);
      const raw64 = new Uint8Array(64);
      raw64.set(seed, 0);
      raw64.set(pub, 32);
      privateKey = privateKeyFromRaw(raw64);
    } else {
      privateKey = await generateKeyPair('Ed25519');
    }

    const peerDiscovery = [];
    if (this.config.bootstrapPeers && this.config.bootstrapPeers.length > 0) {
      peerDiscovery.push(bootstrap({ list: this.config.bootstrapPeers }));
    }
    if (this.config.enableMdns !== false) {
      peerDiscovery.push(mdns());
    }

    const isCore = this.config.nodeRole === 'core';
    const enableRelay = this.config.enableRelayServer ?? isCore;

    // Relay-server capacity tuning. When relay is enabled, derive HOP/STOP
    // stream caps and the connectionManager.maxConnections ceiling from
    // the operator-configured (or default) capacity. Edge nodes that
    // don't run a relay server keep the legacy 500-connection ceiling and
    // the upstream libp2p stream defaults — the bumped caps carry no
    // benefit there and we don't want to inflate the blast radius of
    // this change beyond Core Nodes.
    if (this.config.relayServerCapacity != null && !enableRelay) {
      console.warn(
        `[dkg-core] relayServerCapacity=${this.config.relayServerCapacity} ` +
          `set but relay server is not enabled (nodeRole=${this.config.nodeRole ?? 'edge'}, ` +
          `enableRelayServer=${this.config.enableRelayServer}); value ignored`,
      );
    }
    // Validate the operator-supplied capacity (defends against 0,
    // negatives, NaN, Infinity, fractional values, non-numbers — any
    // of which would propagate into libp2p's stream/connection caps
    // and produce invalid limits or startup failures, per Codex
    // tier-1 finding on PR #524). Invalid values fall back to the
    // documented default with a loud warning so the misconfig is
    // visible.
    let effectiveRelayCapacity: number | null = null;
    if (enableRelay) {
      const verdict = validateRelayServerCapacity(this.config.relayServerCapacity);
      if (verdict == null) {
        effectiveRelayCapacity = DEFAULT_RELAY_SERVER_CAPACITY;
      } else if (verdict.ok) {
        effectiveRelayCapacity = verdict.value;
      } else {
        console.warn(
          `[dkg-core] relayServerCapacity=${String(this.config.relayServerCapacity)} ` +
            `is invalid (${verdict.reason}); falling back to default ${DEFAULT_RELAY_SERVER_CAPACITY}`,
        );
        effectiveRelayCapacity = DEFAULT_RELAY_SERVER_CAPACITY;
      }
    }
    const relayCaps = effectiveRelayCapacity != null ? deriveRelayCaps(effectiveRelayCapacity) : null;

    // Number of relay reservations to hold in parallel. Only meaningful
    // for EDGE nodes behind NAT (relayPeers configured AND no relay
    // server enabled here). Core / relay-server nodes have public
    // addresses and don't need to reserve slots on other relays for
    // incoming traffic — branarakic's PR #526 review caught that the
    // daemon's CLI fallback supplies `network.relays` to both core and
    // edge by default, so amplifying 1 → 3 on the core fleet would
    // multiply reservation-slot consumption network-wide for no
    // benefit.
    //
    // Behaviour by role:
    //   - Core node  (enableRelay=true) + relayPeers set:  push 1
    //     `/p2p-circuit` (legacy fallback behaviour, preserves any
    //     defensive multi-relay config) and IGNORE
    //     relayReservationCount with a warning if it was set.
    //   - Edge node  (enableRelay=false) + relayPeers set: apply
    //     relayReservationCount (default 3, clamped to relayPeers.length
    //     so we never request more reservations than there are
    //     configured relays to fulfil them).
    //   - Any node without relayPeers: skip entirely.
    //
    // Validation defends against the same surface as relayServerCapacity
    // (0/neg/NaN/fractional/non-number/over-cap).
    // Build the canonical "usable relay candidates" list ONCE, before
    // anything else looks at relayPeers. The set produced here is the
    // single source of truth for both the reservation-count clamp
    // below AND the `relayTargets` push later — keeping them in sync.
    //
    // Codex PR #526 round 5 caught that the previous "distinct peerId
    // count" used by the clamp could disagree with the actual
    // `relayTargets` set in two ways: it counted entries pointing at
    // this node's own peerId (later filtered out), and it could be 0
    // when every entry was malformed (which then clamped a perfectly
    // valid `relayReservationCount` to 0 — silently disabling
    // multi-reservation). The canonical list here applies all three
    // filters (parse → drop-self → dedup) once, with explicit warnings
    // for each rejection category.
    //
    // Self-peerId derivation: needs `peerIdFromPrivateKey(privateKey)`
    // here because libp2p hasn't been created yet (`this.node` is set
    // by `createLibp2p({ privateKey, ... })` further down). We have
    // `privateKey` from the keypair-setup block above, and libp2p's
    // own peerId is deterministic from it, so this matches what
    // `this.node.peerId` will be.
    const selfPeerIdEarly = peerIdFromPrivateKey(privateKey);
    const usableRelayCandidates: RelayTarget[] = [];
    if (this.config.relayPeers?.length) {
      const { multiaddr: parseMultiaddr } = await import('@multiformats/multiaddr');
      // Per-peerId aggregation: same peerId with DIFFERENT multiaddrs
      // (e.g. `[relayA-tcp, relayA-ws]`) collapses to one
      // `RelayTarget` carrying BOTH addrs — libp2p tries each in
      // order on dial, so a stale transport doesn't take the relay
      // out of rotation. Same peerId with the SAME multiaddr (e.g.
      // `[relayA, relayA]` or copy-paste) is the true-duplicate
      // case and gets dropped + warned.
      //
      // Map keyed by `pid.toString()` (the canonical peerId
      // encoding) rather than the raw `/p2p/<value>` string a user
      // might have written — Codex PR #526 round 5e caught that the
      // raw string can be base58btc OR base32 OR other encodings of
      // the same peerId, so a mixed-encoding config would bypass
      // the dedupe and inflate `usableRelayCandidates.length`.
      const candidateByPid = new Map<string, RelayTarget>();
      const seenAddrKeys = new Set<string>();
      let malformed = 0;
      let selfHits = 0;
      let dupAddrs = 0;
      let altAddrs = 0;
      for (const raw of this.config.relayPeers) {
        let ma;
        try {
          ma = parseMultiaddr(raw);
        } catch {
          malformed += 1;
          continue;
        }
        const p2p = ma.getComponents().find((c) => c.name === 'p2p')?.value;
        if (!p2p) {
          malformed += 1;
          continue;
        }
        let pid;
        try {
          pid = peerIdFromString(p2p);
        } catch {
          malformed += 1;
          continue;
        }
        if (pid.equals(selfPeerIdEarly)) {
          selfHits += 1;
          continue;
        }
        // Build a canonical address key (transport prefix + canonical
        // peerId) so duplicates are detected regardless of which
        // peerId encoding the operator wrote.
        const pidStr = pid.toString();
        const transportPrefix = ma.toString().split('/p2p/')[0] ?? ma.toString();
        const canonicalAddrKey = `${transportPrefix}/p2p/${pidStr}`;
        if (seenAddrKeys.has(canonicalAddrKey)) {
          dupAddrs += 1;
          continue;
        }
        seenAddrKeys.add(canonicalAddrKey);
        const existing = candidateByPid.get(pidStr);
        if (existing) {
          existing.addrs.push(ma);
          altAddrs += 1;
        } else {
          const target: RelayTarget = { peerId: pid, addrs: [ma] };
          candidateByPid.set(pidStr, target);
          usableRelayCandidates.push(target);
        }
      }
      // Codex PR #526 round 5e: only emit at warn level when there's
      // an actual problem (malformed/self/duplicate). Pure alternate-
      // address aggregation is a healthy supported config and
      // shouldn't trip operator log filters at warning level on
      // every startup.
      const problemReasons: string[] = [];
      if (malformed) problemReasons.push(`${malformed} malformed (no /p2p component or unparseable)`);
      if (selfHits) problemReasons.push(`${selfHits} pointing at this node's own peerId`);
      if (dupAddrs) problemReasons.push(`${dupAddrs} exact-duplicate multiaddrs`);
      if (problemReasons.length > 0) {
        const reasons = [...problemReasons];
        if (altAddrs) reasons.push(`${altAddrs} alternate addrs merged into existing relay peers`);
        console.warn(
          `[dkg-core] relayPeers: ${this.config.relayPeers.length} entries supplied, ` +
            `${usableRelayCandidates.length} distinct relay peers usable (${reasons.join(', ')})`,
        );
      } else if (altAddrs) {
        console.log(
          `[dkg-core] relayPeers: ${this.config.relayPeers.length} entries supplied, ` +
            `${usableRelayCandidates.length} distinct relay peers (${altAddrs} alternate addrs merged)`,
        );
      }
    }

    let relayReservationCount = DEFAULT_RELAY_RESERVATION_COUNT;
    // Gate multi-reservation on USABLE peers, not raw config length —
    // a config like `relayPeers: [malformed, self]` has length>0 but
    // 0 usable, so the node should fall back to the no-relays path
    // (no `/p2p-circuit` listen addrs, no watchdog, no
    // reservationConcurrency override). Codex PR #526 round 5.
    const isEdgeWithRelays = !enableRelay && usableRelayCandidates.length > 0;
    if (isEdgeWithRelays) {
      const verdict = validateRelayReservationCount(this.config.relayReservationCount);
      // Only an `ok` verdict means the operator EXPLICITLY supplied a
      // valid count. `null` (unset → default) and a `not ok` verdict
      // (invalid → fell back to default with its own warning) both
      // produce the default value, and we shouldn't double-warn on
      // clamps that result from the default sizing not matching a
      // small relay set. Codex PR #526 round 5d caught that healthy
      // 1-relay edge nodes were emitting a "clamping to 1" warning
      // on every startup with no operator misconfig — buries real
      // problems in log noise.
      const isExplicitOverride = verdict?.ok === true;
      if (verdict == null) {
        relayReservationCount = DEFAULT_RELAY_RESERVATION_COUNT;
      } else if (verdict.ok) {
        relayReservationCount = verdict.value;
      } else {
        console.warn(
          `[dkg-core] relayReservationCount=${String(this.config.relayReservationCount)} ` +
            `is invalid (${verdict.reason}); falling back to default ${DEFAULT_RELAY_RESERVATION_COUNT}`,
        );
        relayReservationCount = DEFAULT_RELAY_RESERVATION_COUNT;
      }
      // Clamp to the USABLE relay count (post-parse, post-self-filter,
      // post-dedup). This guarantees the runtime
      // `this.relayReservationCountTarget` always matches the actual
      // `this.relayTargets.length` the watchdog will iterate, so the
      // gate `reservedRelayCount >= target` is achievable.
      const usableCount = usableRelayCandidates.length;
      if (relayReservationCount > usableCount) {
        if (isExplicitOverride) {
          // Operator explicitly asked for more reservations than there
          // are usable relays — surface that loudly, it's almost
          // certainly a config error.
          console.warn(
            `[dkg-core] relayReservationCount=${relayReservationCount} exceeds ` +
              `usable relay peers=${usableCount}; clamping to ${usableCount}`,
          );
        }
        relayReservationCount = usableCount;
      }
    } else if (
      this.config.relayReservationCount != null &&
      !this.config.relayPeers?.length
    ) {
      console.warn(
        `[dkg-core] relayReservationCount=${this.config.relayReservationCount} ` +
          `set but no relayPeers configured; value ignored`,
      );
    } else if (
      this.config.relayReservationCount != null &&
      !enableRelay &&
      this.config.relayPeers?.length &&
      usableRelayCandidates.length === 0
    ) {
      console.warn(
        `[dkg-core] relayReservationCount=${this.config.relayReservationCount} ` +
          `set but no usable relayPeers (all malformed/self/duplicate); value ignored`,
      );
    } else if (this.config.relayReservationCount != null && enableRelay) {
      console.warn(
        `[dkg-core] relayReservationCount=${this.config.relayReservationCount} ` +
          `set but this node runs a relay server (nodeRole=${this.config.nodeRole ?? 'edge'}, ` +
          `enableRelayServer=${this.config.enableRelayServer}); ` +
          `relay servers don't multi-reserve through other relays; value ignored`,
      );
    }

    const activeNetworkRelayPeerIds = this.config.networkIdentity
      ? new Set(usableRelayCandidates.map(({ peerId }) => peerId.toString()))
      : undefined;
    const activeRelayNetworkPolicy = buildActiveRelayNetworkPolicy(
      activeNetworkRelayPeerIds,
      { log: (message) => console.warn(`[${new Date().toISOString()}] ${message}`) },
    );
    const activeRelayDiscoveryFilter = activeRelayNetworkPolicy?.discoveryFilter;

    // TCP keepAlive helps prevent idle relay connections from being dropped by
    // middleboxes or remote timeouts (common cause of ECONNRESET).
    const transports: any[] = [
      tcp({ dialOpts: { keepAlive: true } }),
      webSockets(),
      // STOP stream caps default to 300 in libp2p; on a Core Node holding
      // 1024+ reservations that's a lower ceiling than maxReservations
      // implies. Bump the transport-side caps to match the server-side
      // capacity. Edge nodes keep the upstream defaults (passing
      // undefined here is the same as omitting the field).
      //
      // reservationConcurrency controls how many reservations libp2p will
      // attempt in parallel on different relays. Default upstream is 1,
      // which serializes our N pending /p2p-circuit slots and effectively
      // collapses multi-reservation back to single-reservation. Set to
      // relayReservationCount so all N slots are attempted concurrently
      // at startup. Only set on EDGE nodes with relayPeers — core /
      // relay-server nodes don't multi-reserve through other relays.
      circuitRelayTransport(
        relayCaps
          ? {
              maxInboundStopStreams: relayCaps.maxInboundStopStreams,
              maxOutboundStopStreams: relayCaps.maxOutboundStopStreams,
              ...(activeRelayDiscoveryFilter ? { discoveryFilter: activeRelayDiscoveryFilter } : {}),
              ...(isEdgeWithRelays
                ? { reservationConcurrency: relayReservationCount }
                : {}),
            }
          : isEdgeWithRelays
            ? {
                reservationConcurrency: relayReservationCount,
                ...(activeRelayDiscoveryFilter ? { discoveryFilter: activeRelayDiscoveryFilter } : {}),
              }
            : undefined,
      ),
    ];

    // Nodes that already know their NAT status skip autoNAT probing:
    // - usable relayPeers configured → agent behind NAT (knows it needs relay)
    // - enableRelayServer/core → public node acting as relay
    //
    // Gated on `usableRelayCandidates.length > 0` rather than raw
    // `relayPeers.length` (Codex PR #526 round 5c): when every
    // configured relay is filtered out as malformed/self/duplicate,
    // the node falls back to the no-relays path and would otherwise
    // also lose AutoNAT — leaving it with neither relay reachability
    // nor NAT probing. Re-using the same predicate as
    // `isEdgeWithRelays` keeps the two gates in sync.
    const useAutoNAT = this.config.enableAutoNAT ??
      !(usableRelayCandidates.length > 0 || enableRelay);

    const services: Record<string, any> = {
      identify: identify(),
      // WAL and other opt-in protocol families can be registered after the
      // base agent has started. Identify Push makes that registrar change
      // visible to already-connected peers without reconnecting them.
      identifyPush: identifyPush(),
      ping: ping(),
      dht: kadDHT(buildKadDHTOptions(
        this.config,
        dhtProtocolForNetwork(
          this.config.networkIdentity?.networkId,
          this.config.networkIdentity?.chainId,
        ),
      )),
      pubsub: gossipsub({
        emitSelf: false,
        allowPublishToZeroTopicPeers: true,
        floodPublish: true,
        maxInboundDataLength: DKG_GOSSIP_MAX_RPC_BYTES,
        maxOutboundBufferSize: DKG_GOSSIP_MAX_RPC_BYTES,
        D: 4,
        Dlo: 2,
        Dhi: 8,
        // NOTE — RFC 07 §5.4 ships the constant `dkgGossipMsgId` for
        // cross-backend dedup, but it is intentionally NOT wired in
        // here yet. Codex review feedback on PR #501 (round 2) flagged
        // a real rolling-upgrade hazard: gossipsub puts msgIds into
        // its IHAVE/IWANT control protocol, so during a rolling
        // network upgrade old (default upstream `msgIdFnStrictSign`)
        // and new (`dkgGossipMsgId`) nodes compute different IDs for
        // the same payload and stop correlating cache entries. Push
        // delivery still works (the message itself is the same wire
        // bytes); only the dedup cache fragments, producing extra
        // IWANT/SERVE round-trips per message until the upgrade
        // completes. For an isolated devnet that's fine; for a live
        // mainnet mesh it's wasteful and observable.
        //
        // Plan: keep using upstream's default `msgIdFnStrictSign` here
        // (signed = sha256(from || seqno), unsigned = sha256(data)),
        // ship `dkgGossipMsgId` and its tests so the constant is
        // pinned and reviewable, and flip the wiring as part of a
        // coordinated mesh-wide upgrade — most likely combined with a
        // gossipsub protocol-version bump so old/new nodes segregate
        // into separate meshes during the cutover instead of degrading
        // a shared one.
        //
        // Cross-references:
        //   - The function lives at
        //     `packages/core/src/network/gossip-msg-id.ts` with the
        //     full encoding test suite at
        //     `packages/core/test/gossip-msg-id.test.ts`.
        //   - The architectural rationale + cutover plan is documented
        //     in the RFC 07 spec doc `07_IN_PROCESS_PEER_RESOLVER.md`
        //     §5.4 + Phase 5, which lives in the sibling `dkgv10-spec`
        //     repository (not in this repo). Re-stated in summary form
        //     above so the wiring decision is reviewable in-place.
      }),
      dcutr: dcutr(),
    };

    if (useAutoNAT) {
      services.autoNAT = autoNAT();
    }

    if (enableRelay && relayCaps) {
      // Stash the capacity for later getRelayStats() so consumers can
      // compute utilization without re-deriving it.
      this.relayCapacity = relayCaps.maxReservations;
      // Instantiate the byte-counting Metrics adapter ONLY when the
      // relay server is enabled — there's no point counting relay
      // bytes on a node that isn't relaying. The adapter is passed
      // into createLibp2p() below.
      this.relayMetrics = new RelayMetricsAdapter();
      services.relay = circuitRelayServer({
        // Bumped from the libp2p default (no cap → unlimited but
        // bottlenecked by maxOutboundStopStreams=300) to the derived
        // capacity-scaled value so a Core Node can actually serve N
        // simultaneous active circuits when N reservations are held.
        maxInboundHopStreams: relayCaps.maxInboundHopStreams,
        maxOutboundHopStreams: relayCaps.maxOutboundHopStreams,
        maxOutboundStopStreams: relayCaps.maxOutboundStopStreams,
        reservations: {
          maxReservations: relayCaps.maxReservations,
          // Per-circuit duration; bumped 5min → 30min so chat-style
          // intermittent traffic doesn't tear circuits down underneath
          // the application during quiet windows.
          defaultDurationLimit: RELAY_DEFAULT_DURATION_LIMIT_MS,
          // Reservation TTL set explicitly (matches libp2p default of
          // 2h) so operators tuning relay behaviour see the value
          // here instead of having to grep upstream.
          reservationTtl: RELAY_RESERVATION_TTL_MS,
          // Durable graph syncs regularly exceed the previous 16 MiB
          // per-circuit ceiling. Hitting that ceiling resets an otherwise
          // healthy relayed connection mid-page and forces the requester to
          // retry from its last safe graph checkpoint. Raising the forwarding
          // allowance does not pre-allocate memory; it only permits a circuit
          // to carry a realistic multi-KA catch-up before its 30-minute limit.
          defaultDataLimit: BigInt(256 * 1024 * 1024),
        },
      });
      // Route the ulimit log emission to the appropriate console sink
      // by level. The "ok" line is purely informational; only the
      // under-provisioned and unreadable-limit paths warrant warn.
      checkFdLimit(relayCaps.maxConnections, (level, msg) => {
        if (level === 'warn') {
          console.warn(`[dkg-core] ${msg}`);
        } else {
          console.info(`[dkg-core] ${msg}`);
        }
      });
    }

    const listenAddrs = [
      ...(this.config.listenAddresses ?? [
        '/ip4/0.0.0.0/tcp/0',
        '/ip4/0.0.0.0/tcp/0/ws',
      ]),
    ];

    // When relay peers are configured, listen on circuit addresses to ensure
    // the node requests a reservation and becomes reachable through relays.
    // Each `/p2p-circuit` listen address triggers a separate reservation
    // slot in libp2p's transport reservation store (see
    // `@libp2p/circuit-relay-v2/transport/reservation-store.js#reserveRelay`),
    // so pushing N entries → N reservations on N (preferentially distinct)
    // relays.
    //
    // Edge nodes get N (relayReservationCount, default 3, clamped to
    // relayPeers.length) for N-(N-1) fault tolerance. Core / relay-server
    // nodes that also have relayPeers set keep the legacy single
    // `/p2p-circuit` (preserves any defensive multi-relay config without
    // multiplying slot consumption across the core fleet — branarakic
    // PR #526 review).
    if (isEdgeWithRelays) {
      for (let i = 0; i < relayReservationCount; i++) {
        listenAddrs.push('/p2p-circuit');
      }
      this.relayReservationCountTarget = relayReservationCount;
    } else if (enableRelay && this.config.relayPeers?.length) {
      // Core / relay-server node with explicit relayPeers — push the
      // legacy single /p2p-circuit listen addr (preserves defensive
      // multi-relay config without multiplying slot consumption).
      //
      // Gated on `enableRelay` (Codex PR #526 round 5): the previous
      // `else if (relayPeers?.length)` also matched edge nodes where
      // every relayPeers entry got filtered out as
      // malformed/self/duplicate (so isEdgeWithRelays became false).
      // That left the edge half-configured — a `/p2p-circuit`
      // listener with nothing to reserve against — and inconsistent
      // with the "value ignored" warning we already emitted up top.
      // Now the unusable case truly hits the no-relays path.
      listenAddrs.push('/p2p-circuit');
      this.relayReservationCountTarget = 1;
    }

    // Explicit field shape (NOT `Record<string, number>`) so a typo in
    // a new key fails to compile instead of silently disabling the
    // tunable. Mirrors `PersistentPeerStoreInit` from
    // `@libp2p/peer-store`; if upstream adds a third knob we want to
    // expose, the `buildPeerStoreOverrides` return type is the single
    // place to extend. Codex review of PR #698 caught the prior loose
    // typing; round 2 then asked for a wiring test, which lives in
    // `core/test/libp2p-tunables-wiring.test.ts` against the same
    // helper.
    const peerStoreOverrides = buildPeerStoreOverrides(this.config);

    this.node = await createLibp2p<DKGServices>({
      privateKey,
      ...(peerStoreOverrides !== undefined
        ? { peerStore: peerStoreOverrides }
        : {}),
      // `nodeInfo.userAgent` is libp2p's only knob for the identify
      // protocol's `agentVersion` PB field — every remote peer reads
      // it back as `Peer.metadata.AgentVersion`. Without it, libp2p
      // defaults to `js-libp2p/<version>`, a libp2p-toolkit version
      // that tells a remote operator nothing about which DKG release
      // this peer is running. The daemon (see
      // packages/cli/src/daemon/lifecycle.ts) sets `nodeVersion` to
      // `dkg/<semver>` so /api/peer-info can answer "which DKG release
      // is each peer running?" from the wire.
      ...(this.config.nodeVersion
        ? { nodeInfo: { userAgent: this.config.nodeVersion } }
        : {}),
      addresses: {
        listen: listenAddrs,
        ...(this.config.announceAddresses?.length
          ? { announce: this.config.announceAddresses }
          : {}),
      },
      transports: transports as any,
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery,
      services,
      connectionGater: this.createRelayConnectionGater(activeRelayNetworkPolicy?.connectionGater),
      connectionManager: {
        minConnections: 0,
        // Core Nodes scale this with relayServerCapacity (default
        // capacity=1024 → maxConnections=2048). Edge nodes keep the
        // legacy 500-connection ceiling — they have no relay-server
        // pressure and wider headroom adds nothing.
        maxConnections: relayCaps?.maxConnections ?? EDGE_NODE_MAX_CONNECTIONS,
      },
      // Inject the byte-counting Metrics adapter only on Core Nodes
      // (relay enabled). On edge nodes libp2p uses its built-in
      // no-op metrics; the adapter is purely additive.
      ...(this.relayMetrics ? { metrics: () => this.relayMetrics! } : {}),
    } as any);
    this.stopAbortController = startStopAbortController;

    this.setupConnectionObservability();

    // Connect to relay peers and tag them as keep-alive so libp2p's
    // connection manager maintains the connection and auto-redials.
    // The list `usableRelayCandidates` was already fully filtered
    // (parse + drop-self + dedup) up top — push it as-is so
    // `this.relayTargets` is exactly the same set the clamp sized
    // against. Codex PR #526 round 5 fixed the previous mismatch
    // where the clamp could pass a count larger than what
    // `relayTargets` actually held.
    if (usableRelayCandidates.length > 0) {
      for (const candidate of usableRelayCandidates) {
        this.relayTargets.push(candidate);

        // Merge ALL addrs for this peer so libp2p can fall back to
        // alternates if the primary multiaddr is stale (Codex PR #526
        // round 5c).
        await this.node.peerStore.merge(candidate.peerId, {
          multiaddrs: candidate.addrs,
          tags: {
            'keep-alive-dkg-relay': { value: 100 },
          },
        });

        try {
          // libp2p `dial` accepts an array of multiaddrs and tries
          // them in order — leverages every supplied transport.
          await this.node.dial(candidate.addrs);
        } catch {
          // watchdog will retry
        }
      }

      this.startRelayWatchdog();
    }
  }

  /**
   * Periodically check that relay connections are alive. After a network
   * outage (e.g. laptop sleep/wake) TCP sockets die silently and libp2p
   * won't automatically redial. Uses exponential backoff when the relay is
   * unreachable and resets to the base interval on successful reconnect.
   */
  private startRelayWatchdog(): void {
    if (this.relayWatchdogTimer) return;
    if (this.relayTargets.length === 0) return;

    this.scheduleWatchdogTick();
  }

  private scheduleWatchdogTick(): void {
    const delay = Math.min(
      RELAY_WATCHDOG_BASE_INTERVAL_MS * Math.pow(2, this.relayWatchdogConsecutiveFailures),
      RELAY_WATCHDOG_MAX_INTERVAL_MS,
    );

    this.relayWatchdogTimer = setTimeout(async () => {
      await this.watchdogTick();
      if (this.node) this.scheduleWatchdogTick();
    }, delay);

    if (this.relayWatchdogTimer.unref) {
      this.relayWatchdogTimer.unref();
    }
  }

  private async watchdogTick(): Promise<void> {
    const node = this.node;
    if (!node) return;

    const ts = () => new Date().toISOString();
    const short = (id: string) => id.slice(-8);
    let allHealthy = true;
    // `onlyWaitingOnGraceWindow` stays true as long as every reason we
    // marked a relay unhealthy this tick was "we just redialed and are
    // still inside the reservation grace window". That's a benign
    // waiting state — we don't want to count it against the watchdog's
    // exponential backoff, because doubling the next delay to 20s/40s/…
    // for a ≤15s grace means a genuinely missing reservation can go
    // unchecked for multiple minutes after a single forced redial.
    // Codex tier-4g finding on the `allHealthy = false; continue` line
    // a few blocks below.
    let onlyWaitingOnGraceWindow = true;

    // Snapshot advertised self-multiaddrs once per tick. The presence of
    // *any* /p2p-circuit self-address is the authoritative signal that
    // libp2p has at least one live circuit reservation somewhere. Recent
    // js-libp2p circuit-relay-v2 defaults to holding a single reservation
    // at a time, so we treat the reservation set as a pool, not per-relay.
    // `haveAnyReservation` is evaluated per-iteration from a mutable
    // snapshot (`refreshReservationSnapshot`), not once before the loop.
    // A successful redial can restore a reservation mid-tick and every
    // remaining relay must see that fresh state — otherwise a healthy
    // idle relay gets torn down by the `transportUp && !haveAnyReservation`
    // branch just because it was scanned after the recovery. Codex
    // tier-4l finding at packages/core/src/node.ts:351. We keep the
    // first snapshot so the "this relay currently holds the reservation"
    // hint stays accurate within a single iteration.
    let circuitSelfAddrs = node.getMultiaddrs().map(ma => ma.toString()).filter(a => a.includes('/p2p-circuit'));
    let haveAnyReservation = circuitSelfAddrs.length > 0;
    // A publicly-reachable node — one advertising a direct, non-circuit
    // public self-address (e.g. a Core Node on a public IP) — does not need
    // client-side circuit reservations at all: peers dial it directly. On
    // such a node libp2p never forms a `/p2p-circuit` self-addr, so
    // `haveAnyReservation` stays false forever and the reservation-recovery
    // branch below would `close()` + redial every relay-target connection on
    // each grace-window expiry — permanent churn against the very sibling
    // cores that StorageACK streams run over. (2026-07-07 Gnosis mainnet: the
    // watchdog dropping 61u7AUrG/Xw8orCA1 aborted in-flight ACK streams →
    // empty replies the publisher mislabeled as INVALID_SIGNATURE.) When the
    // node is publicly reachable we treat every relay's reservation gate as
    // satisfied and skip the forced drop+redial; the benign
    // reconnect-on-disconnect path below still keeps relay connections alive
    // for NAT'd peers that reach us over a hop. Snapshotted once per tick —
    // a node's public-ness doesn't change mid-tick.
    const nodeIsPubliclyReachable = nodeHasDirectPublicAddress(
      node.getMultiaddrs().map((ma) => ma.toString()),
    );
    // Distinct count of CONFIGURED relays that currently hold a
    // reservation. This is the "do we have enough reservations?"
    // signal — not "does every peer hold one?". Recomputed alongside
    // `circuitSelfAddrs` so a successful mid-tick redial that brings
    // the count up to target flips remaining peers' gates from
    // "needs recovery" to "satisfied" without further churn.
    const computeReservedRelayCount = () => this.relayTargets.filter(({ peerId }) =>
      !peerId.equals(node.peerId) &&
      circuitSelfAddrs.some(a => a.includes(`/p2p/${peerId.toString()}/p2p-circuit`)),
    ).length;
    let reservedRelayCount = computeReservedRelayCount();
    const refreshReservationSnapshot = () => {
      circuitSelfAddrs = node.getMultiaddrs().map(ma => ma.toString()).filter(a => a.includes('/p2p-circuit'));
      haveAnyReservation = circuitSelfAddrs.length > 0;
      reservedRelayCount = computeReservedRelayCount();
    };
    // Per-tick budget for forced reservation-redials. Codex PR #526
    // round 5: a completed `node.dial()` does NOT guarantee the new
    // `/p2p-circuit` self-address has propagated, so during recovery
    // from `1/2 reservations` in a `3 peers, target=2` setup the
    // post-dial `refreshReservationSnapshot()` may still report
    // `reservedRelayCount === 1` and the loop would keep redialing the
    // remaining peer too — overshooting the target and re-introducing
    // the churn this PR is meant to avoid. Cap forced redials at the
    // missing-slot count computed at TICK START (deliberately not
    // recomputed mid-tick): once we've initiated dials for every
    // missing slot, the in-flight reservations will fill them
    // asynchronously, and the next watchdog tick will reassess. If a
    // dial happens to propagate fast enough that
    // `reservationGateSatisfied` flips for the next peer, the happy
    // path skips it naturally — this cap only matters when the
    // reservations haven't propagated yet.
    const missingSlotsAtTickStart = Math.max(
      0,
      this.relayReservationCountTarget - reservedRelayCount,
    );
    let forcedRedialsThisTick = 0;
    const now = Date.now();

    for (const { peerId, addrs } of this.relayTargets) {
      if (peerId.equals(node.peerId)) continue;

      const relayPidStr = peerId.toString();
      const conns = node.getConnections(peerId);
      const transportUp = conns.length > 0;

      const thisRelayHasReservation = circuitSelfAddrs.some(a =>
        a.includes(`/p2p/${relayPidStr}/p2p-circuit`),
      );

      // Happy path. A peer's gate is satisfied if either:
      //
      //   (a) this peer personally holds our reservation, OR
      //   (b) we already have ENOUGH distinct reservations elsewhere
      //       (`reservedRelayCount >= target`).
      //
      // The total-count check (b) is the critical fix vs round 2 of
      // PR #526. The previous "every relay must hold one when target>1"
      // gate broke valid configs like `relayPeers=3, relayReservationCount=2`:
      // the third peer never reserves (count clamps at target=2), so
      // `!thisRelayHasReservation` stayed true forever and the watchdog
      // would tear down + redial it on every grace-window expiry.
      // Codex review on PR #526 round 3 flagged this — see
      // https://github.com/OriginTrail/dkg/pull/526. Counting reserved
      // relays preserves the round-2 fix (silent degradation when
      // target > current is still detected and recovered) without
      // demanding 100% coverage when target < relayPeers.length.
      const reservationGateSatisfied =
        nodeIsPubliclyReachable ||
        thisRelayHasReservation ||
        reservedRelayCount >= this.relayReservationCountTarget;
      if (transportUp && reservationGateSatisfied) {
        this.relayReservationRedialAt.delete(relayPidStr);
        this.relayForcedRedialState.delete(relayPidStr);
        continue;
      }

      // Reservation-recovery branch. Drop + redial THIS relay when:
      //
      //   1. transport is up AND reservations exist nowhere — libp2p's
      //      reservation-pool management has lost every slot.
      //
      //   2. transport is up AND `reservedRelayCount < target` AND this
      //      specific peer is missing one — try to claim one of the
      //      missing slots from this peer. Once the redial succeeds
      //      (`refreshReservationSnapshot` updates `reservedRelayCount`),
      //      remaining peers' gates may flip to "satisfied" naturally
      //      and we stop redialing — no over-reservation, no churn on
      //      the unconfigured-as-target peers.
      const needsForcedReservationRedial =
        transportUp &&
        (
          !haveAnyReservation ||
          (reservedRelayCount < this.relayReservationCountTarget && !thisRelayHasReservation)
        );
      if (needsForcedReservationRedial) {
        // Honour the per-tick redial budget. `missingSlotsAtTickStart`
        // is the deficit at tick start; once we've SUCCESSFULLY
        // dispatched dials for every missing slot we stop, even if
        // the new `/p2p-circuit` self-addrs haven't shown up yet —
        // the in-flight reservations will fill the deficit and the
        // next tick will reassess. Treat this as a benign "still
        // recovering" state, same as a recent forced redial within
        // the grace window: account for it as not-fully-healthy but
        // don't apply exponential backoff (the next tick needs to
        // arrive to see whether the in-flight dials succeeded).
        //
        // Only SUCCESSFUL redials count against the budget (Codex
        // PR #526 round 5c): a failed `node.dial()` shouldn't lock us
        // out of trying the next eligible relay this tick.
        if (
          this.relayReservationCountTarget > 1 &&
          missingSlotsAtTickStart > 0 &&
          forcedRedialsThisTick >= missingSlotsAtTickStart
        ) {
          allHealthy = false;
          continue;
        }
        const lastForcedRedial = this.relayReservationRedialAt.get(relayPidStr) ?? 0;
        if (now - lastForcedRedial < RELAY_RESERVATION_GRACE_MS) {
          // We just redialed; give libp2p time to finish negotiating a new
          // reservation before declaring failure. This is a benign wait,
          // so do NOT clear `onlyWaitingOnGraceWindow` — keeping it true
          // means the tail doesn't apply the exponential backoff, which
          // would otherwise starve the next check well past the grace
          // window itself.
          allHealthy = false;
          continue;
        }

        // Thrash cap: after RELAY_FORCED_REDIAL_MAX_STRIKES consecutive
        // futile forced redials (reservation never appeared — e.g. the
        // relay's slots are exhausted), stop tearing this relay's
        // connection down for RELAY_FORCED_REDIAL_COOLDOWN_MS. The
        // connection keeps carrying app traffic; only the forced
        // reservation-recovery close is suppressed. Benign wait — no
        // backoff escalation (leave `onlyWaitingOnGraceWindow` alone).
        //
        // Honoured only while we hold at least one reservation SOMEWHERE:
        // with zero reservations the node is inbound-unreachable, and if
        // every relay were cooled simultaneously nothing would ever retry
        // (adversarial review round 1). Urgency wins when nothing works;
        // the cap's job is protecting working connections from churn, and
        // the global tick backoff (5-min max) already paces the retries.
        const redialState = this.relayForcedRedialState.get(relayPidStr)
          ?? { strikes: 0, cooldownUntil: 0, busyDeferralTicks: 0 };
        if (now < redialState.cooldownUntil && haveAnyReservation) {
          allHealthy = false;
          continue;
        }

        // Stream-aware deferral: never sever a connection carrying
        // in-flight application request streams — an abrupt close aborts
        // the exchange (StorageACK collection, sync). Deferral is benign:
        // the deficit persists to the next tick, which retries once the
        // request streams have drained. See isWatchdogBusyProtocol for why
        // long-lived streams (gossipsub, pooled messages, kad) don't count.
        //
        // The scan ALSO covers connections relayed THROUGH this relay
        // (`…/p2p/<relay>/p2p-circuit/p2p/<peer>`): tearing down the relay
        // connection severs those circuits and their in-flight exchanges
        // (adversarial review round 1). Only the scan widens — the
        // teardown below still closes just the direct connections.
        //
        // Capped at RELAY_BUSY_DEFERRAL_MAX_TICKS consecutive deferrals so
        // a leaked half-open stream (or any future immortal /dkg/ stream)
        // can only delay recovery, never disable it — after the cap the
        // teardown proceeds and doubles as the stuck-stream reaper.
        const relayedConns = node.getConnections().filter((c: { remoteAddr?: { toString(): string } }) =>
          c.remoteAddr?.toString().includes(`/p2p/${relayPidStr}/p2p-circuit`),
        );
        const busyProtocols = connectionsBusyAppProtocols([...conns, ...relayedConns]);
        if (busyProtocols.length > 0) {
          const busyTicks = redialState.busyDeferralTicks + 1;
          if (busyTicks <= RELAY_BUSY_DEFERRAL_MAX_TICKS) {
            this.relayForcedRedialState.set(relayPidStr, { ...redialState, busyDeferralTicks: busyTicks });
            allHealthy = false;
            console.log(
              `[${ts()}] Relay watchdog: deferring forced redial of ${short(relayPidStr)} — ` +
              `in-flight app stream(s): ${busyProtocols.join(', ')} ` +
              `(deferral ${busyTicks}/${RELAY_BUSY_DEFERRAL_MAX_TICKS})`,
            );
            continue;
          }
          console.log(
            `[${ts()}] Relay watchdog: busy-deferral cap reached for ${short(relayPidStr)} ` +
            `(streams: ${busyProtocols.join(', ')}); proceeding with forced redial`,
          );
        }
        redialState.busyDeferralTicks = 0;

        allHealthy = false;
        // Actual corrective action below (drop + redial); this is a
        // real failure the watchdog must back off on.
        onlyWaitingOnGraceWindow = false;
        const reason = !haveAnyReservation
          ? 'no circuit reservation anywhere (0 /p2p-circuit self-addrs)'
          : `${reservedRelayCount}/${this.relayReservationCountTarget} reservations held; this relay missing`;
        console.log(
          `[${ts()}] Relay watchdog: ${reason}; ` +
          `dropping + redialing ${short(relayPidStr)} to force reserve`,
        );
        this.relayReservationRedialAt.set(relayPidStr, now);
        // Strike accounting: this forced teardown is only ever reached when
        // the previous ones (if any) failed to yield a reservation — the
        // happy path above drops the whole state entry the moment one
        // appears.
        const strikes = redialState.strikes + 1;
        if (strikes >= RELAY_FORCED_REDIAL_MAX_STRIKES) {
          this.relayForcedRedialState.set(relayPidStr, {
            strikes: 0,
            cooldownUntil: now + RELAY_FORCED_REDIAL_COOLDOWN_MS,
            busyDeferralTicks: 0,
          });
          console.log(
            `[${ts()}] Relay watchdog: ${strikes} consecutive forced redials of ${short(relayPidStr)} ` +
            `yielded no reservation (slots likely exhausted); cooling down forced redials for ` +
            `${Math.round(RELAY_FORCED_REDIAL_COOLDOWN_MS / 60_000)}min (connection left alone)`,
          );
        } else {
          this.relayForcedRedialState.set(relayPidStr, { ...redialState, strikes, busyDeferralTicks: 0 });
        }

        // Past the busy-deferral cap, reap the stuck application streams while
        // the transport is still writable. Letting `Connection.close()` abort
        // them concurrently with the underlying socket close can make Yamux's
        // reset frame race the socket teardown (`StreamStateError: Cannot write
        // to a stream that is closing`). Besides surfacing as an unhandled
        // rejection, that race defeats the cap's explicit stuck-stream-reaper
        // purpose. Aborting first gives the reset a turn to flush before the
        // connection itself is closed.
        if (busyProtocols.length > 0) {
          abortWatchdogBusyStreams(
            [...conns, ...relayedConns],
            new Error('relay watchdog busy-deferral cap reached'),
          );
          await new Promise(r => setTimeout(r, 0));
        }

        for (const c of conns) {
          try {
            await c.close();
          } catch {
            // Best-effort: if the close call itself fails we still try to
            // redial below; libp2p will reuse an existing connection if one
            // somehow survived.
          }
        }
        // Brief delay so the remote side has time to release the prior hop
        // reservation slot before we ask for a new one.
        const delayMs = RELAY_REDIAL_DELAY_MS + Math.floor(Math.random() * 1000);
        await new Promise(r => setTimeout(r, delayMs));
        let redialed = false;
        try {
          // Pass all addrs so libp2p tries each transport in order
          // (preserves multi-multiaddr-per-relay configs).
          await node.dial(addrs);
          redialed = true;
          forcedRedialsThisTick += 1;
          console.log(`[${ts()}] Relay watchdog: redialed ${short(relayPidStr)} for fresh reservation`);
        } catch (err: any) {
          console.log(`[${ts()}] Relay watchdog: reservation-redial failed for ${short(relayPidStr)}: ${err.message}`);
        }
        // For single-reservation deployments (target<=1) stop after one
        // recovery attempt per tick: libp2p only holds one reservation at
        // a time, so if this redial restored it, every remaining relay
        // in `this.relayTargets` would still see the stale
        // `!haveAnyReservation` snapshot and tear-down + redial itself
        // in the same tick, briefly dropping all relay paths at once.
        // For multi-reservation (target>1) we want to keep going so all
        // missing slots are restored in a single tick — each relay has
        // an independent per-relay reservation, so restoring relay A
        // doesn't change whether relay B needs the same recovery. We
        // refresh the snapshot first so the next iteration sees the
        // up-to-date reservation set.
        if (redialed) {
          if (this.relayReservationCountTarget <= 1) break;
          refreshReservationSnapshot();
        }
        continue;
      }

      // Transport is down — classic disconnect path. Count against
      // backoff (this is a real failure, not a grace-window wait).
      allHealthy = false;
      onlyWaitingOnGraceWindow = false;
      console.log(`[${ts()}] Relay watchdog: ${short(relayPidStr)} disconnected, redialing…`);
      const delayMs = RELAY_REDIAL_DELAY_MS + Math.floor(Math.random() * 1000);
      await new Promise(r => setTimeout(r, delayMs));
      try {
        await node.dial(addrs);
        console.log(`[${ts()}] Relay watchdog: reconnected to ${short(relayPidStr)}`);
        // Reservation may have been restored by this dial; refresh the
        // snapshot so the next iteration doesn't tear down another
        // healthy relay on stale state.
        refreshReservationSnapshot();
      } catch (err: any) {
        console.log(`[${ts()}] Relay watchdog: redial failed for ${short(relayPidStr)}: ${err.message}`);
      }
    }

    if (allHealthy) {
      this.relayWatchdogConsecutiveFailures = 0;
    } else if (onlyWaitingOnGraceWindow) {
      // Every unhealthy relay this tick was just a benign wait (grace
      // window, busy deferral, or cooldown). Don't inflate the backoff
      // — the next scheduled tick needs to actually arrive while the
      // grace window is still the active state, otherwise a missing
      // reservation can sit uncorrected for minutes. DECAY the counter
      // instead of freezing it (adversarial review round 1): an
      // indefinitely-persistent benign state (long cooldown, busy
      // publisher) previously pinned the shared tick interval at
      // whatever the prior strike sequence escalated it to — walking it
      // back restores base-granularity checks while the state is benign.
      this.relayWatchdogConsecutiveFailures = Math.max(0, this.relayWatchdogConsecutiveFailures - 1);
      const nextDelay = Math.min(
        RELAY_WATCHDOG_BASE_INTERVAL_MS * Math.pow(2, this.relayWatchdogConsecutiveFailures),
        RELAY_WATCHDOG_MAX_INTERVAL_MS,
      );
      console.log(`[${ts()}] Relay watchdog: reservation grace window pending; next check in ${Math.round(nextDelay / 1000)}s`);
    } else {
      this.relayWatchdogConsecutiveFailures++;
      const nextDelay = Math.min(
        RELAY_WATCHDOG_BASE_INTERVAL_MS * Math.pow(2, this.relayWatchdogConsecutiveFailures),
        RELAY_WATCHDOG_MAX_INTERVAL_MS,
      );
      console.log(`[${ts()}] Relay watchdog: next check in ${Math.round(nextDelay / 1000)}s (attempt ${this.relayWatchdogConsecutiveFailures})`);
    }
  }

  private createRelayConnectionGater(activeRelayGater?: RelayedConnectionGater): ConnectionGater {
    const ts = () => new Date().toISOString();
    // The gater hooks live in a pure builder (relay-flap-guard.ts) so the wiring
    // is unit-tested (relay-flap-guard.test.ts) — a hook arg-shape or plumbing
    // regression fails a test instead of silently leaving the guard inert.
    const flapGater = buildRelayFlapConnectionGater(
      this.relayFlapGuard,
      (message) => console.warn(`[${ts()}] ${message}`),
    );
    return {
      denyInboundRelayedConnection: (relay, remotePeer) =>
        activeRelayGater?.denyInboundRelayedConnection(relay, remotePeer) ||
        flapGater.denyInboundRelayedConnection(relay, remotePeer),
      denyDialMultiaddr: (multiaddr) =>
        activeRelayGater?.denyDialMultiaddr(multiaddr) ||
        flapGater.denyDialMultiaddr(multiaddr),
    } as ConnectionGater;
  }

  /**
   * Wire up connection:open / connection:close listeners that track transport
   * type (direct vs relayed) and detect DCUtR upgrades from relay to direct.
   */
  private setupConnectionObservability(): void {
    const node = this.requireNode();
    const ts = () => new Date().toISOString();
    const short = (id: string) => id.slice(-8);

    node.addEventListener('connection:open', (evt) => {
      const conn = evt.detail;
      const pid = conn.remotePeer.toString();
      const addr = conn.remoteAddr?.toString() ?? 'unknown';
      const transport: ConnectionTransport = addr.includes('/p2p-circuit') ? 'relayed' : 'direct';
      const dir = conn.direction;

      if (transport === 'relayed') {
        this.relayedPeers.add(pid);
        console.log(
          `[${ts()}] Connection opened: ${short(pid)} transport=relayed ` +
          `dir=${dir} addr=${addr}`,
        );
      } else {
        const upgraded = this.relayedPeers.has(pid);
        if (upgraded) {
          this.relayedPeers.delete(pid);
          this.relayFlapGuard.clearRemotePeer(pid);
          console.log(
            `[${ts()}] DCUtR upgrade: ${short(pid)} relayed -> direct ` +
            `dir=${dir} addr=${addr}`,
          );
        } else {
          console.log(
            `[${ts()}] Connection opened: ${short(pid)} transport=direct ` +
            `dir=${dir} addr=${addr}`,
          );
        }
      }
    });

    node.addEventListener('connection:close', (evt) => {
      const conn = evt.detail;
      const pid = conn.remotePeer.toString();
      const addr = conn.remoteAddr?.toString() ?? 'unknown';
      const transport: ConnectionTransport = addr.includes('/p2p-circuit') ? 'relayed' : 'direct';
      const durationMs = conn.timeline.close
        ? conn.timeline.close - conn.timeline.open
        : null;

      // If this was the last connection to the peer, clean up tracking state.
      const remaining = node.getConnections(conn.remotePeer);
      if (remaining.length === 0) {
        this.relayedPeers.delete(pid);
      }

      if (transport === 'relayed' && durationMs != null) {
        const relayPath = parseCircuitRelayPeerIds(addr);
        if (relayPath) {
          const result = this.relayFlapGuard.recordRelayedClose({
            relayPeerId: relayPath.relayPeerId,
            remotePeerId: pid,
            durationMs,
            // libp2p's connection:close event carries no reliable failure
            // reason. A one-shot DKG request/response relay circuit normally
            // closes in <1s, so duration alone must never poison the route.
            confirmedFailure: false,
          });
          if (result.enteredQuarantine) {
            console.warn(
              `[${ts()}] Relay flap guard: quarantined relayed path ` +
              `remote=${short(pid)} relay=${short(relayPath.relayPeerId)} ` +
              `shortCloses=${result.shortCloseCount} ` +
              `ttl=${Math.ceil((result.quarantineTtlMs ?? 0) / 1000)}s`,
            );
          }
        }
      } else if (transport === 'direct' && durationMs != null) {
        this.relayFlapGuard.recordDirectClose({ remotePeerId: pid, durationMs });
      }

      console.log(
        `[${ts()}] Connection closed: ${short(pid)} transport=${transport} ` +
        `duration=${durationMs ?? '?'}ms addr=${addr}`,
      );
    });

    node.addEventListener('peer:disconnect', (evt) => {
      const pid = evt.detail.toString();
      this.relayedPeers.delete(pid);
      console.log(`[${ts()}] Peer disconnected: ${short(pid)}`);
    });

    // Log once when this node first becomes remotely-dialable. Closes a
    // cold-start observability gap that the V10 DHT-resolved invite flow
    // exposed: a curator who shares an invite seconds after `dkg start`
    // may have a peer record in the DHT containing only LAN/loopback
    // addresses, so joiners get PEER_NOT_FOUND-ish silent failures. This
    // log line lets operators see the moment the peer record becomes
    // useful (a circuit-relay reservation landed or a public address
    // appeared). Once-per-process; fires from `self:peer:update` which
    // libp2p emits whenever the local peer's announced address set changes.
    let dialableLogged = false;
    const checkDialable = () => {
      if (dialableLogged) return;
      const addrs = node.getMultiaddrs().map((ma) => ma.toString());
      const dialable = addrs.find((a) => a.includes('/p2p-circuit/') || isPublicLikeAddress(a));
      if (!dialable) return;
      dialableLogged = true;
      const kind = dialable.includes('/p2p-circuit/') ? 'circuit-relay' : 'public';
      console.log(
        `[${ts()}] Node is remotely-dialable (${kind}); peer-id invites should now resolve via DHT. ` +
        `addr=${dialable}`,
      );
    };
    node.addEventListener('self:peer:update', checkDialable);
    // libp2p may have already populated multiaddrs by the time we attach
    // the listener (especially for `core` / public nodes whose addresses
    // are known the moment listening succeeds). Cover that race with a
    // single immediate check.
    checkDialable();
  }

  async stop(): Promise<void> {
    if (!this.node) return;
    // PR-6: signal abort FIRST, before any cleanup. The point of
    // the controller is to unblock long-await sites (notably the
    // for-await loop in `protocol-router.ts:readAll`) so that
    // libp2p's own internal teardown — which depends on streams
    // closing — doesn't deadlock waiting for those reads to finish.
    // Aborting + then awaiting libp2p.stop() is the graceful
    // counterpart to PR-1's hard-timeout safety net (#655).
    this.stopAbortController?.abort();
    if (this.relayWatchdogTimer) {
      clearTimeout(this.relayWatchdogTimer);
      this.relayWatchdogTimer = null;
    }
    this.relayTargets = [];
    // Watchdog bookkeeping must not leak into a restarted node: a stale
    // cooldown/strike entry from the previous run would suppress
    // reservation recovery on connections that were recreated from
    // scratch (otReviewAgent on PR #1613).
    this.relayForcedRedialState.clear();
    this.relayWatchdogConsecutiveFailures = 0;
    this.relayReservationRedialAt.clear();
    this.relayedPeers.clear();
    this.relayMetrics = null;
    this.relayCapacity = null;
    this.relayReservationCountTarget = 1;
    const node = this.node;
    try {
      await node.stop();
    } finally {
      if (this.node === node) {
        this.node = null;
      }
      this.stopAbortController = null;
    }
  }

  get peerId(): string {
    return this.requireNode().peerId.toString();
  }

  get peerIdBytes(): Uint8Array {
    return this.requireNode().peerId.toMultihash().bytes;
  }

  get multiaddrs(): string[] {
    return this.requireNode()
      .getMultiaddrs()
      .map((ma) => ma.toString());
  }

  get libp2p(): Libp2p<DKGServices> {
    return this.requireNode();
  }

  /** Publish the current libp2p registrar protocol set to connected peers. */
  async pushProtocolAdvertisement(): Promise<void> {
    await this.requireNode().services.identifyPush.push();
  }

  get isStarted(): boolean {
    return this.node !== null;
  }

  /**
   * Live relay-server statistics. Returns `null` on edge nodes (no
   * relay server enabled). On Core Nodes returns:
   *
   *   - `capacity`         — operator-configured maxReservations
   *   - `reservationCount` — how many reservations are currently held
   *   - `activeCircuits`   — count of OUTBOUND STOP streams currently
   *                          open on this node. On a relay server, each
   *                          forwarded circuit is implemented as a HOP
   *                          stream (from the dialer) piped into an
   *                          outbound STOP stream (to the reservee);
   *                          counting outbound STOP streams alone gives
   *                          exactly one per forwarded circuit. The
   *                          `direction === 'outbound'` filter excludes
   *                          inbound STOP streams (which are this node
   *                          BEING a reservee, not forwarding traffic).
   *                          NOTE: forwarded relay traffic does NOT
   *                          show up as `/p2p-circuit` connections on
   *                          the relay host — that multiaddr exists
   *                          only on the edge endpoints.
   *   - `bytesIn` / `bytesOut`  — total bytes seen on HOP+STOP streams
   *                                since relay startup, counted by the
   *                                RelayMetricsAdapter via libp2p's
   *                                `trackProtocolStream` seam. bytesIn
   *                                is bytes ARRIVING at the relay's
   *                                HOP+STOP endpoints; bytesOut is bytes
   *                                DEPARTING. BigInt because a busy Core
   *                                Node can saturate Number.MAX_SAFE in
   *                                a few weeks of high traffic.
   *   - `reservations[]`   — per-reservee detail: peerId, expiry timestamp,
   *                          optional limit copy. Suitable for
   *                          /api/relay/stats but NOT for the periodic
   *                          snapshot table (it's unbounded).
   */
  getRelayStats(): RelayStats | null {
    if (!this.node || !this.relayMetrics) return null;

    // Reservations + per-connection streams are libp2p-internal shapes
    // that aren't part of the public TypeScript types. Codex review on
    // PR #525 round 4 caught that scattering `(x as any).y` casts at
    // the use sites makes a future libp2p refactor silently break the
    // metrics — these helpers concentrate the brittleness in one
    // tested module that returns null on shape mismatch.
    const reservationsMap = readRelayReservations(this.node);
    if (!reservationsMap) return null;

    const reservations: RelayReservationDetail[] = [];
    let reservationCount = 0;
    reservationsMap.forEach((rawReservation, peerId) => {
      reservationCount += 1;
      try {
        const reservation = rawReservation as RelayReservationInfo | undefined;
        const expiry = reservation?.expiry instanceof Date ? reservation.expiry.getTime() : null;
        const addr = reservation?.addr?.toString?.() ?? null;
        reservations.push({
          peerId: peerId.toString(),
          expiryTs: expiry,
          addr,
          limitDurationMs:
            typeof reservation?.limit?.duration === 'number'
              ? reservation.limit.duration
              : null,
          limitDataBytes:
            typeof reservation?.limit?.data === 'bigint'
              ? Number(reservation.limit.data)
              : typeof reservation?.limit?.data === 'number'
                ? reservation.limit.data
                : null,
        });
      } catch {
        // Best-effort — a single misshapen reservation entry must
        // not poison the whole stats payload.
      }
    });

    // Count active forwarded circuits by counting OUTBOUND STOP streams
    // across all connections. On the relay server, each forwarded circuit
    // = exactly one STOP stream the relay opened (outbound) to the
    // reservee. The matching HOP stream is also open during the
    // lifetime of a circuit, but counting STOP alone gives exactly N
    // rather than 2N.
    //
    // The `direction === 'outbound'` filter is critical when this node
    // is also a relay client (relayPeers configured). Without it, the
    // STOP streams opened TO us as a reservee (direction='inbound')
    // would be counted as forwarded circuits even though no traffic
    // is being relayed BY this node — same architectural concern as the
    // adapter's `isRelayServerStream` direction filter. Codex review
    // on PR #525 (round 2) caught this for the metrics counters; this
    // line was the parallel issue in `getRelayStats()`.
    //
    // (See libp2p-metrics-adapter.ts for the full HOP/STOP architecture
    // comment + direction matrix.)
    let activeCircuits = 0;
    try {
      for (const conn of this.node.getConnections()) {
        const streams = readConnectionStreams(conn);
        if (!streams) continue;
        for (const s of streams) {
          if (s?.protocol === RELAY_V2_STOP_CODEC && s?.direction === 'outbound') {
            activeCircuits += 1;
          }
        }
      }
    } catch {
      /* defensive: connection / stream list iteration shouldn't throw */
    }

    const bytes = this.relayMetrics.snapshot();

    return {
      capacity: this.relayCapacity ?? 0,
      reservationCount,
      activeCircuits,
      bytesIn: bytes.bytesIn,
      bytesOut: bytes.bytesOut,
      reservations,
    };
  }

  private requireNode(): Libp2p<DKGServices> {
    if (!this.node) throw new Error('DKGNode not started');
    return this.node;
  }
}

interface RelayReservationInfo {
  expiry?: Date;
  addr?: { toString(): string };
  limit?: { duration?: number; data?: bigint | number };
}

/** Per-reservee detail returned by `getRelayStats()`. */
export interface RelayReservationDetail {
  /** PeerId of the reservee (the node holding the reservation). */
  peerId: string;
  /** Reservation expiry as a unix-ms timestamp; null if upstream omits it. */
  expiryTs: number | null;
  /** Multiaddr string the reservation was issued for; null if unreadable. */
  addr: string | null;
  /** Per-circuit duration cap in ms, or null if upstream omits it. */
  limitDurationMs: number | null;
  /** Per-circuit data cap in bytes, or null if upstream omits it. */
  limitDataBytes: number | null;
}

/** Live relay-server statistics returned by `DKGNode.getRelayStats()`. */
export interface RelayStats {
  /** Operator-configured maxReservations cap. */
  capacity: number;
  /** Number of reservations currently held. Always ≤ capacity in healthy state. */
  reservationCount: number;
  /**
   * Active forwarded circuits RIGHT NOW. Counted as the number of open
   * STOP streams (`/libp2p/circuit/relay/0.2.0/stop`) on this node — one
   * per circuit being forwarded. NOTE: forwarded circuits do not show up
   * as `/p2p-circuit` connections on the relay host; that multiaddr only
   * exists on the edge endpoints (dialer + reservee).
   */
  activeCircuits: number;
  /** Bytes received via 'message' events on HOP+STOP relay-server streams since startup. */
  bytesIn: bigint;
  /** Bytes sent via .send() on HOP+STOP relay-server streams since startup. */
  bytesOut: bigint;
  /** Per-reservee detail (unbounded; suitable for the /api/relay/stats route, NOT for periodic snapshots). */
  reservations: RelayReservationDetail[];
}
