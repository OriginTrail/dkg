/**
 * Expiry timers for the reservations this node holds as a circuit-relay
 * server.
 *
 * `@libp2p/circuit-relay-v2` gives every server-side reservation a
 * `retimeable-signal` and re-times it with `reset()` when the client
 * refreshes. Up to `retimeable-signal` 1.0.1 the first `reset()` attaches
 * its abort listener as an anonymous function, so the second `reset()`
 * cannot detach it: the timer armed by the first refresh keeps running.
 * With the 2 h TTL and a client refresh 5 minutes before expiry the relay
 * deletes the reservation 235 minutes after creating it, and every circuit
 * relayed under it is aborted. The client stays connected, believes it
 * still holds the reservation, and dialers get NO_RESERVATION until its
 * next refresh about 110 minutes later re-creates it.
 *
 * The store has two more gaps this module closes:
 * - `removeReservation()` (the store's failure path for a reservation
 *   reply) leaves the removed reservation's timers running, and when one
 *   fires its listener deletes whatever reservation the peer holds by
 *   then, so a fresh reservation can vanish minutes after it was made.
 * - A refresh does not move `expiry`, so the relay statistics show a
 *   refreshed reservation as expired.
 *
 * The repair swaps each new reservation's signal for one whose timer a
 * refresh really moves, deletes the reservation only while it is still the
 * peer's current one, and stops the timer of a removed reservation. It is a
 * no-op when the installed `retimeable-signal` is newer than the last
 * faulty release.
 */
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { setMaxListeners } from 'node:events';

/** Newest `retimeable-signal` release whose `reset()` leaves a timer armed. */
export const LAST_FAULTY_RETIMEABLE_SIGNAL_VERSION = '1.0.1';

/** What `repairRelayReservationTimers` did, for the start-up log line. */
export type RelayReservationTimerRepair = 'repaired' | 'not-needed' | 'unavailable';

/** A reservation signal: aborts at expiry, re-timed by a refresh. */
export interface ReservationSignalLike extends AbortSignal {
  reset?: (ms?: number) => void;
  clear?: () => void;
}

interface ServerReservationLike {
  expiry?: Date;
  signal: ReservationSignalLike;
}

interface ServerReservationMapLike {
  get(peer: unknown): ServerReservationLike | undefined;
  delete(peer: unknown): unknown;
  forEach(callback: (reservation: ServerReservationLike, peer: unknown) => void): void;
}

/** The parts of circuit-relay-v2's server `ReservationStore` the repair wraps. */
interface ServerReservationStoreLike {
  reservations: ServerReservationMapLike;
  reservationTtl?: unknown;
  reserve(peer: unknown, ...rest: unknown[]): { status?: unknown; expire?: unknown } | undefined;
  removeReservation(peer: unknown): void;
  clear(): void;
}

export interface RelayReservationTimerRepairOptions {
  /** Installed `retimeable-signal` version; read from disk when omitted. */
  retimeableSignalVersion?: string | null;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

const repairedStores = new WeakSet<object>();
const repairedSignals = new WeakSet<AbortSignal>();

/**
 * Install the reservation timer repair on a running relay server
 * (`libp2p.services.relay`). Safe to call more than once.
 */
export function repairRelayReservationTimers(
  relayService: unknown,
  options: RelayReservationTimerRepairOptions = {},
): RelayReservationTimerRepair {
  const log = options.log ?? ((message: string) => console.log(`[${new Date().toISOString()}] ${message}`));
  const warn = options.warn ?? ((message: string) => console.warn(`[${new Date().toISOString()}] ${message}`));
  const version = options.retimeableSignalVersion === undefined
    ? readRetimeableSignalVersion()
    : options.retimeableSignalVersion;
  if (version !== null && !isFaultyRetimeableSignalVersion(version)) {
    log(`Relay reservation timers: retimeable-signal ${version} re-times reservations correctly; no repair needed`);
    return 'not-needed';
  }
  const store = readServerReservationStore(relayService);
  if (!store) {
    warn('Relay reservation timers: the relay server reservation store has an unexpected shape; refreshed reservations may expire early');
    return 'unavailable';
  }
  if (repairedStores.has(store)) return 'repaired';
  repairedStores.add(store);

  const ttlMs = typeof store.reservationTtl === 'number' && store.reservationTtl > 0
    ? store.reservationTtl
    : undefined;
  const adopt = (peer: unknown, reservation: ServerReservationLike): void => {
    const remainingMs = (reservation.expiry?.getTime() ?? 0) - Date.now();
    const lifetimeMs = remainingMs > 0 ? remainingMs : ttlMs;
    if (lifetimeMs === undefined) return;
    // A signal that was never reset still detaches its only timer on clear().
    reservation.signal.clear?.();
    reservation.signal = createReservationSignal(lifetimeMs, () => {
      if (store.reservations.get(peer) === reservation) store.reservations.delete(peer);
    });
  };
  store.reservations.forEach((reservation, peer) => {
    if (!repairedSignals.has(reservation.signal)) adopt(peer, reservation);
  });

  const reserve = store.reserve.bind(store);
  const removeReservation = store.removeReservation.bind(store);
  const clear = store.clear.bind(store);
  store.reserve = (peer, ...rest) => {
    const before = store.reservations.get(peer);
    const result = reserve(peer, ...rest);
    const after = store.reservations.get(peer);
    if (after !== undefined && (after !== before || !repairedSignals.has(after.signal))) {
      adopt(peer, after);
    } else if (after !== undefined && typeof result?.expire === 'number') {
      // The reply carries the refreshed expiry (seconds); the store keeps the old one.
      after.expiry = new Date(result.expire * 1000);
    }
    return result;
  };
  store.removeReservation = (peer) => {
    store.reservations.get(peer)?.signal.clear?.();
    removeReservation(peer);
  };
  store.clear = () => {
    store.reservations.forEach((reservation) => reservation.signal.clear?.());
    clear();
  };
  log(`Relay reservation timers: repaired for retimeable-signal ${version ?? '(version unknown)'}`);
  return 'repaired';
}

/**
 * An abort signal that fires `ms` after creation, re-timed by `reset()` and
 * stopped by `clear()`; `onExpire` runs before the signal aborts.
 */
export function createReservationSignal(ms: number, onExpire: () => void): ReservationSignalLike {
  const controller = new AbortController();
  const signal: ReservationSignalLike = controller.signal;
  // Every circuit relayed under the reservation listens on this signal.
  setMaxListeners(Infinity, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (delay: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onExpire();
      controller.abort(Object.assign(new Error('Relay reservation expired'), { name: 'AbortError' }));
    }, delay);
    timer.unref?.();
  };
  signal.reset = (next = ms) => {
    if (!signal.aborted) arm(next);
  };
  signal.clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  arm(ms);
  repairedSignals.add(signal);
  return signal;
}

/** True for `retimeable-signal` versions up to the last faulty release. */
export function isFaultyRetimeableSignalVersion(version: string): boolean {
  const parse = (value: string) => value.split('-')[0]!.split('.').map((part) => Number.parseInt(part, 10));
  const installed = parse(version);
  const lastFaulty = parse(LAST_FAULTY_RETIMEABLE_SIGNAL_VERSION);
  if (installed.length !== 3 || installed.some((part) => !Number.isFinite(part))) return true;
  for (let index = 0; index < 3; index++) {
    if (installed[index]! !== lastFaulty[index]!) return installed[index]! < lastFaulty[index]!;
  }
  return true;
}

/** The `retimeable-signal` version circuit-relay-v2 loads; `null` when it cannot be found. */
export function readRetimeableSignalVersion(fromUrl: string | URL = import.meta.url): string | null {
  return readDependencyVersion(fromUrl, '@libp2p/circuit-relay-v2', 'retimeable-signal');
}

/**
 * The version of `dependency` that `parent` loads, found the way Node
 * resolves it (from `parent`'s own directory, which follows pnpm's links);
 * `null` when either cannot be found. Neither package of interest exports
 * its `package.json`, so this reads the files instead of resolving them.
 */
export function readDependencyVersion(fromUrl: string | URL, parent: string, dependency: string): string | null {
  try {
    const parentDir = findPackageDir(createRequire(fromUrl), parent);
    if (!parentDir) return null;
    const dependencyDir = findPackageDir(createRequire(join(realpathSync(parentDir), 'package.json')), dependency);
    if (!dependencyDir) return null;
    const { version } = JSON.parse(readFileSync(join(dependencyDir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

function findPackageDir(require: NodeJS.Require, name: string): string | null {
  for (const dir of require.resolve.paths(name) ?? []) {
    const candidate = join(dir, name);
    try {
      readFileSync(join(candidate, 'package.json'));
      return candidate;
    } catch {
      // not installed at this level
    }
  }
  return null;
}

function readServerReservationStore(relayService: unknown): ServerReservationStoreLike | null {
  if (!relayService || typeof relayService !== 'object') return null;
  const store = (relayService as { reservationStore?: unknown }).reservationStore;
  if (!store || typeof store !== 'object') return null;
  const { reservations, reserve, removeReservation, clear } = store as Record<string, unknown>;
  if (typeof reserve !== 'function' || typeof removeReservation !== 'function' || typeof clear !== 'function') return null;
  if (!reservations || typeof reservations !== 'object') return null;
  const map = reservations as Record<string, unknown>;
  if (typeof map.get !== 'function' || typeof map.delete !== 'function' || typeof map.forEach !== 'function') return null;
  return store as ServerReservationStoreLike;
}
