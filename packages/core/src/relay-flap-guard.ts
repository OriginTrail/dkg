export const RELAY_FLAP_SHORT_CLOSE_MS = 1_000;
export const RELAY_FLAP_WINDOW_MS = 60_000;
export const RELAY_FLAP_THRESHOLD = 5;
export const RELAY_FLAP_BASE_QUARANTINE_MS = 2 * 60_000;
export const RELAY_FLAP_MAX_QUARANTINE_MS = 10 * 60_000;
export const RELAY_FLAP_STABLE_CLOSE_MS = 10_000;
export const RELAY_FLAP_DENY_LOG_INTERVAL_MS = 30_000;

const KEY_SEPARATOR = '\u001f';

export interface RelayPathPeerIds {
  relayPeerId: string;
  remotePeerId?: string;
}

export interface RelayFlapGuardOptions {
  shortCloseMs?: number;
  windowMs?: number;
  threshold?: number;
  baseQuarantineMs?: number;
  maxQuarantineMs?: number;
  stableCloseMs?: number;
  denyLogIntervalMs?: number;
}

export interface RelayFlapCloseResult {
  shortClose: boolean;
  shortCloseCount: number;
  enteredQuarantine: boolean;
  cleared: boolean;
  quarantineUntil?: number;
  quarantineTtlMs?: number;
}

export interface RelayFlapDenyResult {
  deny: boolean;
  shouldLog: boolean;
  quarantineUntil?: number;
  quarantineMsRemaining?: number;
}

interface RelayFlapPairState {
  relayPeerId: string;
  remotePeerId: string;
  shortCloseTimes: number[];
  quarantineUntil: number;
  strikes: number;
  lastDenyLogAt?: number;
}

export interface RelayFlapPairSnapshot {
  relayPeerId: string;
  remotePeerId: string;
  shortCloseCount: number;
  quarantineUntil: number;
  strikes: number;
}

function defaultedOptions(options: RelayFlapGuardOptions): Required<RelayFlapGuardOptions> {
  return {
    shortCloseMs: options.shortCloseMs ?? RELAY_FLAP_SHORT_CLOSE_MS,
    windowMs: options.windowMs ?? RELAY_FLAP_WINDOW_MS,
    threshold: options.threshold ?? RELAY_FLAP_THRESHOLD,
    baseQuarantineMs: options.baseQuarantineMs ?? RELAY_FLAP_BASE_QUARANTINE_MS,
    maxQuarantineMs: options.maxQuarantineMs ?? RELAY_FLAP_MAX_QUARANTINE_MS,
    stableCloseMs: options.stableCloseMs ?? RELAY_FLAP_STABLE_CLOSE_MS,
    denyLogIntervalMs: options.denyLogIntervalMs ?? RELAY_FLAP_DENY_LOG_INTERVAL_MS,
  };
}

function pairKey(relayPeerId: string, remotePeerId: string): string {
  return `${relayPeerId}${KEY_SEPARATOR}${remotePeerId}`;
}

function clampPositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

export function parseCircuitRelayPeerIds(addr: string): RelayPathPeerIds | null {
  const parts = addr.split('/').filter(Boolean);
  const circuitIndex = parts.indexOf('p2p-circuit');
  if (circuitIndex === -1) return null;

  let relayPeerId: string | undefined;
  for (let i = circuitIndex - 1; i >= 0; i--) {
    if (parts[i] === 'p2p' && i + 1 < circuitIndex) {
      relayPeerId = parts[i + 1];
      break;
    }
  }
  if (!relayPeerId) return null;

  let remotePeerId: string | undefined;
  for (let i = circuitIndex + 1; i < parts.length - 1; i++) {
    if (parts[i] === 'p2p') {
      remotePeerId = parts[i + 1];
      break;
    }
  }

  return { relayPeerId, remotePeerId };
}

export class RelayFlapGuard {
  private readonly options: Required<RelayFlapGuardOptions>;
  private readonly pairs = new Map<string, RelayFlapPairState>();

  constructor(options: RelayFlapGuardOptions = {}) {
    const defaults = defaultedOptions(options);
    this.options = {
      shortCloseMs: clampPositiveInteger(defaults.shortCloseMs, RELAY_FLAP_SHORT_CLOSE_MS),
      windowMs: clampPositiveInteger(defaults.windowMs, RELAY_FLAP_WINDOW_MS),
      threshold: clampPositiveInteger(defaults.threshold, RELAY_FLAP_THRESHOLD),
      baseQuarantineMs: clampPositiveInteger(defaults.baseQuarantineMs, RELAY_FLAP_BASE_QUARANTINE_MS),
      maxQuarantineMs: clampPositiveInteger(defaults.maxQuarantineMs, RELAY_FLAP_MAX_QUARANTINE_MS),
      stableCloseMs: clampPositiveInteger(defaults.stableCloseMs, RELAY_FLAP_STABLE_CLOSE_MS),
      denyLogIntervalMs: clampPositiveInteger(defaults.denyLogIntervalMs, RELAY_FLAP_DENY_LOG_INTERVAL_MS),
    };
  }

  recordRelayedClose(input: {
    relayPeerId: string;
    remotePeerId: string;
    durationMs: number;
    now?: number;
  }): RelayFlapCloseResult {
    const now = input.now ?? Date.now();
    if (input.durationMs >= this.options.stableCloseMs) {
      return {
        shortClose: false,
        shortCloseCount: 0,
        enteredQuarantine: false,
        cleared: this.clearPair(input.relayPeerId, input.remotePeerId),
      };
    }

    const key = pairKey(input.relayPeerId, input.remotePeerId);
    const existing = this.pairs.get(key);
    if (input.durationMs >= this.options.shortCloseMs) {
      if (existing) {
        this.prune(existing, now);
        this.evictIfIdle(key, existing, now);
      }
      return {
        shortClose: false,
        shortCloseCount: existing?.shortCloseTimes.length ?? 0,
        enteredQuarantine: false,
        cleared: false,
        quarantineUntil: existing?.quarantineUntil,
      };
    }

    const state = existing ?? {
      relayPeerId: input.relayPeerId,
      remotePeerId: input.remotePeerId,
      shortCloseTimes: [],
      quarantineUntil: 0,
      strikes: 0,
    };
    this.pairs.set(key, state);
    this.prune(state, now);
    state.shortCloseTimes.push(now);

    if (state.quarantineUntil > now) {
      return {
        shortClose: true,
        shortCloseCount: state.shortCloseTimes.length,
        enteredQuarantine: false,
        cleared: false,
        quarantineUntil: state.quarantineUntil,
      };
    }

    if (state.shortCloseTimes.length < this.options.threshold) {
      return {
        shortClose: true,
        shortCloseCount: state.shortCloseTimes.length,
        enteredQuarantine: false,
        cleared: false,
        quarantineUntil: state.quarantineUntil,
      };
    }

    state.strikes += 1;
    const quarantineTtlMs = Math.min(
      this.options.baseQuarantineMs * Math.pow(2, state.strikes - 1),
      this.options.maxQuarantineMs,
    );
    state.quarantineUntil = now + quarantineTtlMs;
    state.shortCloseTimes = [];
    state.lastDenyLogAt = undefined;

    return {
      shortClose: true,
      shortCloseCount: this.options.threshold,
      enteredQuarantine: true,
      cleared: false,
      quarantineUntil: state.quarantineUntil,
      quarantineTtlMs,
    };
  }

  checkRelayedConnection(input: {
    relayPeerId: string;
    remotePeerId: string;
    now?: number;
  }): RelayFlapDenyResult {
    const now = input.now ?? Date.now();
    const key = pairKey(input.relayPeerId, input.remotePeerId);
    const state = this.pairs.get(key);
    if (!state) return { deny: false, shouldLog: false };

    if (state.quarantineUntil <= now) {
      // Quarantine lapsed — prune stale closes, and if the pair now carries no
      // useful state, evict it so the map stays bounded on long-lived nodes.
      this.prune(state, now);
      this.evictIfIdle(key, state, now);
      return { deny: false, shouldLog: false };
    }

    const shouldLog =
      state.lastDenyLogAt == null ||
      now - state.lastDenyLogAt >= this.options.denyLogIntervalMs;
    if (shouldLog) state.lastDenyLogAt = now;

    return {
      deny: true,
      shouldLog,
      quarantineUntil: state.quarantineUntil,
      quarantineMsRemaining: state.quarantineUntil - now,
    };
  }

  clearPair(relayPeerId: string, remotePeerId: string): boolean {
    return this.pairs.delete(pairKey(relayPeerId, remotePeerId));
  }

  recordDirectClose(input: {
    remotePeerId: string;
    durationMs: number;
  }): number {
    if (input.durationMs < this.options.stableCloseMs) return 0;
    return this.clearRemotePeer(input.remotePeerId);
  }

  clearRemotePeer(remotePeerId: string): number {
    let cleared = 0;
    for (const [key, state] of this.pairs.entries()) {
      if (state.remotePeerId === remotePeerId) {
        this.pairs.delete(key);
        cleared++;
      }
    }
    return cleared;
  }

  getPairState(relayPeerId: string, remotePeerId: string, now = Date.now()): RelayFlapPairSnapshot | undefined {
    const state = this.pairs.get(pairKey(relayPeerId, remotePeerId));
    if (!state) return undefined;
    this.prune(state, now);
    return {
      relayPeerId: state.relayPeerId,
      remotePeerId: state.remotePeerId,
      shortCloseCount: state.shortCloseTimes.length,
      quarantineUntil: state.quarantineUntil,
      strikes: state.strikes,
    };
  }

  private prune(state: RelayFlapPairState, now: number): void {
    const cutoff = now - this.options.windowMs;
    state.shortCloseTimes = state.shortCloseTimes.filter((ts) => ts >= cutoff);
  }

  /**
   * Drop a pair from the tracking map once it carries no useful state — no
   * in-window short closes AND no active quarantine. Without this the map grows
   * without bound on long-lived nodes that see many transient relayed peers,
   * and stale `strikes` would inflate future quarantines via the exponential
   * backoff. Returns true if the entry was evicted.
   */
  private evictIfIdle(key: string, state: RelayFlapPairState, now: number): boolean {
    if (state.shortCloseTimes.length === 0 && state.quarantineUntil <= now) {
      this.pairs.delete(key);
      return true;
    }
    return false;
  }
}

/**
 * Minimal structural shape of the libp2p ConnectionGater hooks this guard
 * implements. Kept structural (`{ toString(): string }`) so the gater can be
 * unit-tested without importing libp2p's PeerId/Multiaddr types — the module
 * stays a dependency-free, pure state machine.
 */
export interface RelayFlapConnectionGater {
  denyInboundRelayedConnection(relay: { toString(): string }, remotePeer: { toString(): string }): boolean;
  denyDialMultiaddr(multiaddr: { toString(): string }): boolean;
}

export interface RelayConnectionGaterOptions {
  /**
   * When set, only these relay peer ids may be used for circuit-relay paths.
   * `undefined` preserves the legacy open relay-path behavior.
   */
  activeRelayPeerIds?: ReadonlySet<string>;
}

export interface RelayDiscoveryFilter {
  has(peerId: { toString(): string }): boolean;
  add(peerId: { toString(): string }): void;
  remove(peerId: { toString(): string }): void;
}

export function buildActiveRelayDiscoveryFilter(
  activeRelayPeerIds: ReadonlySet<string> | undefined,
): RelayDiscoveryFilter | undefined {
  if (activeRelayPeerIds == null) return undefined;
  const seen = new Set<string>();
  return {
    has(peerId) {
      const id = peerId.toString();
      return !activeRelayPeerIds.has(id) || seen.has(id);
    },
    add(peerId) {
      const id = peerId.toString();
      if (activeRelayPeerIds.has(id)) seen.add(id);
    },
    remove(peerId) {
      seen.delete(peerId.toString());
    },
  };
}

/**
 * Build the libp2p connection-gater hooks that enforce a `RelayFlapGuard`.
 * Extracted as a pure function so the WIRING (not just the guard) is testable:
 * a regression in the hook arg-shapes or guard plumbing fails a unit test
 * rather than silently leaving the guard inert in production.
 *
 * NOTE on `denyDialMultiaddr`: libp2p (>=3.x / @libp2p/interface 3.x) invokes
 * this hook with a SINGLE argument — the multiaddr. The remote peer id, when
 * known, is encoded in that multiaddr as `/p2p/<id>`; `parseCircuitRelayPeerIds`
 * pulls both the relay and remote ids out of a `/p2p-circuit` address. (Older
 * libp2p passed `(peerId, multiaddr)` — we are NOT on that shape.)
 */
export function buildRelayFlapConnectionGater(
  guard: RelayFlapGuard,
  log: (message: string) => void = () => {},
  options: RelayConnectionGaterOptions = {},
): RelayFlapConnectionGater {
  const short = (id: string): string => id.slice(-8);
  const denyInactiveRelayPath = (
    direction: 'inbound' | 'outbound',
    relayPeerId: string,
    remotePeerId?: string,
    addr?: string,
  ): boolean => {
    if (options.activeRelayPeerIds == null || options.activeRelayPeerIds.has(relayPeerId)) {
      return false;
    }
    log(
      `Network isolation: denying ${direction} relayed connection ` +
      `relay=${short(relayPeerId)}${remotePeerId ? ` remote=${short(remotePeerId)}` : ''}` +
      `${addr ? ` addr=${addr}` : ''}`,
    );
    return true;
  };
  const denyRelayedPath = (
    direction: 'inbound' | 'outbound',
    relayPeerId: string,
    remotePeerId: string,
    addr?: string,
  ): boolean => {
    const result = guard.checkRelayedConnection({ relayPeerId, remotePeerId });
    if (!result.deny) return false;
    if (result.shouldLog) {
      const remainingSeconds = Math.ceil((result.quarantineMsRemaining ?? 0) / 1000);
      log(
        `Relay flap guard: denying ${direction} relayed connection ` +
        `remote=${short(remotePeerId)} relay=${short(relayPeerId)} ` +
        `quarantineRemaining=${remainingSeconds}s${addr ? ` addr=${addr}` : ''}`,
      );
    }
    return true;
  };
  return {
    denyInboundRelayedConnection: (relay, remotePeer) =>
      denyInactiveRelayPath('inbound', relay.toString(), remotePeer.toString()) ||
      denyRelayedPath('inbound', relay.toString(), remotePeer.toString()),
    denyDialMultiaddr: (multiaddr) => {
      const addr = multiaddr.toString();
      const parsed = parseCircuitRelayPeerIds(addr);
      if (!parsed) return false;
      if (denyInactiveRelayPath('outbound', parsed.relayPeerId, parsed.remotePeerId, addr)) return true;
      if (!parsed.remotePeerId) return false;
      return denyRelayedPath('outbound', parsed.relayPeerId, parsed.remotePeerId, addr);
    },
  };
}
