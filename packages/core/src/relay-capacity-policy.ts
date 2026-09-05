/** Resource limits derived from circuit-relay reservations. No runtime dependencies. */
export const RELAY_CAPACITY_MULTIPLIER = 2;

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

/** FD headroom is separate from the reservation-to-connection ratio. */
export const FD_HEADROOM_MULTIPLIER = 2;
export const MIN_OPEN_FILE_LIMIT = 4096;
export function recommendOpenFileLimit(maxConnections: number): number {
  return Math.max(MIN_OPEN_FILE_LIMIT, maxConnections * FD_HEADROOM_MULTIPLIER);
}
