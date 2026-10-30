import type { ContextGraphWritePreflightProbe } from '@origintrail-official/dkg-agent';
import {
  WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS,
  WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_STRICT,
} from '@origintrail-official/dkg-agent/write-preflight-unresolved-window';

/**
 * Concurrent writes into one context graph share a single write-preflight probe (OT-RFC-73 S4a).
 *
 * Under load many async share and publish submissions probe the same graph for the same caller at
 * once, and each probe is several store reads. A call that finds a probe in flight for the same
 * context graph and the same caller joins it instead of starting another. Two calls are
 * interchangeable only while the agent's identity for them (`writePreflightIdentity`: key and stamp)
 * is equal, so a call never joins a probe that began before a write to a policy source or a change of
 * the graph's subscription: that probe stays with the callers that already joined it, and the new
 * caller starts its own. An agent without an identity, or the switch turned off, is probed directly,
 * exactly as before. The agent gives no identity while a write to a policy source has an unknown outcome
 * (a store deadline: the store may still apply it later), so nothing is joined, read from the cache or kept
 * in it for that time. How long that time is, is the agent's write-preflight policy, set here from
 * `DKG_WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS` (default 120 s, 0 for strict); it is a best-effort window,
 * not a guarantee of any store, and its residual risk is stated in the agent's `dkg-agent-write-preflight.ts`.
 *
 * Optionally (off by default) a probe that ended in a fast accept is kept for a short time and
 * served to the same caller again. It is never kept when it could be stale in a way the stamp does
 * not see: a store that was down, an answer that consulted the chain, a probe during which the stamp
 * moved. A negative answer is never kept either: it is cheaper to ask again than to keep a refusal
 * after the cause went away.
 *
 * Every elapsed-time decision here (the join limit, the cache TTL) is measured on a monotonic clock
 * (`performance.now`), never on the wall clock: a correction of the system clock, in either direction, can neither
 * keep an old probe joinable past `WRITE_PREFLIGHT_FLIGHT_MAX_JOIN_MS` nor keep a cache entry past its TTL. The
 * agent measures its unresolved-write window the same way (`WritePreflightGeneration`). No wall-clock time is
 * reported from here.
 */

/** Turns coalescing off (`0`, `false`, `no`, `off`) or on (the default). Applies after a daemon restart. */
export const WRITE_PREFLIGHT_COALESCING_ENV = 'DKG_WRITE_PREFLIGHT_COALESCING';
/** Turns the fast-accept result cache on (`1`, `true`, `yes`, `on`); off by default. It needs coalescing. */
export const WRITE_PREFLIGHT_CACHE_ENV = 'DKG_WRITE_PREFLIGHT_CACHE';
/** How long the result cache keeps a fast accept, in milliseconds. */
export const WRITE_PREFLIGHT_CACHE_TTL_ENV = 'DKG_WRITE_PREFLIGHT_CACHE_TTL_MS';
/**
 * How long sharing stays off after a policy write ended with an unknown outcome, in whole milliseconds; `0` is
 * strict (it stays off for the rest of the process). The agent's write-preflight policy, not a store guarantee.
 */
export const WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV = 'DKG_WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS';

export const WRITE_PREFLIGHT_CACHE_DEFAULT_TTL_MS = 2_000;
export const WRITE_PREFLIGHT_CACHE_MIN_TTL_MS = 100;
export const WRITE_PREFLIGHT_CACHE_MAX_TTL_MS = 10_000;
/** Per agent; the oldest entry goes first. */
export const WRITE_PREFLIGHT_CACHE_MAX_ENTRIES = 256;
/** A probe in flight this long is not joined: a call that hangs must not hold every later caller. */
export const WRITE_PREFLIGHT_FLIGHT_MAX_JOIN_MS = 10_000;

export interface WritePreflightCoalescingConfig {
  readonly coalescing: boolean;
  /** 0 when the result cache is off. */
  readonly cacheTtlMs: number;
  /** Handed to the agent: the unresolved-write window in ms; 0 is strict. Read whatever the two switches say. */
  readonly unresolvedWriteWindowMs: number;
}

export interface WritePreflightCoalescingLogger {
  info(message: string): void;
  warn(message: string): void;
}

type Switch = 'on' | 'off' | 'unset' | 'invalid';

function readSwitch(raw: string | undefined): Switch {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'unset';
  if (value === '1' || value === 'true' || value === 'yes' || value === 'on') return 'on';
  if (value === '0' || value === 'false' || value === 'no' || value === 'off') return 'off';
  return 'invalid';
}

function printable(raw: string | undefined): string {
  return JSON.stringify(raw?.trim().slice(0, 64));
}

/**
 * The unresolved-write window: unset or blank is the agent's default, a whole number of milliseconds is taken
 * as it is (`0` is strict), and anything else falls back to the default, with a warning.
 */
function readUnresolvedWriteWindowMs(
  env: Readonly<Record<string, string | undefined>>,
  logger?: Pick<WritePreflightCoalescingLogger, 'warn'>,
): number {
  const raw = env[WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV]?.trim();
  if (!raw) return WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (Number.isSafeInteger(parsed)) return parsed;
  logger?.warn(
    `Invalid ${WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV}=${printable(raw)}; expected whole milliseconds ` +
    `(0 for strict). Using ${WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS}.`,
  );
  return WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS;
}

/**
 * Reads the four variables. A value that is not recognized leaves its feature off, with a warning,
 * so that a mistyped rollback can never leave coalescing on and a mistyped opt-in never turns the
 * cache on. A TTL is clamped to its range, or falls back to the default when it is not a number, and so
 * does the unresolved-write window.
 */
export function resolveWritePreflightCoalescingConfig(
  env: Readonly<Record<string, string | undefined>>,
  logger?: Pick<WritePreflightCoalescingLogger, 'warn'>,
): WritePreflightCoalescingConfig {
  const coalescingSwitch = readSwitch(env[WRITE_PREFLIGHT_COALESCING_ENV]);
  if (coalescingSwitch === 'invalid') {
    logger?.warn(
      `Invalid ${WRITE_PREFLIGHT_COALESCING_ENV}=${printable(env[WRITE_PREFLIGHT_COALESCING_ENV])}; ` +
      'expected on or off (1/0, true/false, yes/no). Write preflight coalescing stays off.',
    );
  }
  const coalescing = coalescingSwitch === 'unset' || coalescingSwitch === 'on';
  const unresolvedWriteWindowMs = readUnresolvedWriteWindowMs(env, logger);

  const cacheSwitch = readSwitch(env[WRITE_PREFLIGHT_CACHE_ENV]);
  if (cacheSwitch === 'invalid') {
    logger?.warn(
      `Invalid ${WRITE_PREFLIGHT_CACHE_ENV}=${printable(env[WRITE_PREFLIGHT_CACHE_ENV])}; ` +
      'expected on or off (1/0, true/false, yes/no). The write preflight result cache stays off.',
    );
  }
  if (cacheSwitch !== 'on' || !coalescing) {
    if (cacheSwitch === 'on') {
      logger?.warn(`${WRITE_PREFLIGHT_CACHE_ENV} is ignored while write preflight coalescing is off.`);
    }
    return { coalescing, cacheTtlMs: 0, unresolvedWriteWindowMs };
  }

  const rawTtl = env[WRITE_PREFLIGHT_CACHE_TTL_ENV]?.trim();
  let cacheTtlMs = WRITE_PREFLIGHT_CACHE_DEFAULT_TTL_MS;
  if (rawTtl) {
    const parsed = /^\d+$/.test(rawTtl) ? Number(rawTtl) : Number.NaN;
    if (!Number.isSafeInteger(parsed)) {
      logger?.warn(
        `Invalid ${WRITE_PREFLIGHT_CACHE_TTL_ENV}=${printable(rawTtl)}; expected whole milliseconds. ` +
        `Using ${WRITE_PREFLIGHT_CACHE_DEFAULT_TTL_MS}.`,
      );
    } else {
      cacheTtlMs = Math.min(WRITE_PREFLIGHT_CACHE_MAX_TTL_MS, Math.max(WRITE_PREFLIGHT_CACHE_MIN_TTL_MS, parsed));
      if (cacheTtlMs !== parsed) {
        logger?.warn(
          `${WRITE_PREFLIGHT_CACHE_TTL_ENV}=${parsed} is outside ` +
          `${WRITE_PREFLIGHT_CACHE_MIN_TTL_MS}..${WRITE_PREFLIGHT_CACHE_MAX_TTL_MS}; using ${cacheTtlMs}.`,
        );
      }
    }
  }
  return { coalescing, cacheTtlMs, unresolvedWriteWindowMs };
}

let effectiveConfig: WritePreflightCoalescingConfig = {
  coalescing: true, cacheTtlMs: 0, unresolvedWriteWindowMs: WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS,
};

function describeUnresolvedWriteWindow(windowMs: number): string {
  return windowMs === WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_STRICT
    ? 'strict (no sharing for the rest of the process after an unknown policy write)'
    : `${windowMs} ms`;
}

/** Resolves the switches and logs the outcome once, at daemon start (which also zeroes the counters); a change needs a restart. */
export function configureWritePreflightCoalescing(
  env: Readonly<Record<string, string | undefined>>,
  logger: WritePreflightCoalescingLogger,
): WritePreflightCoalescingConfig {
  effectiveConfig = resolveWritePreflightCoalescingConfig(env, logger);
  // A daemon run counts from zero.
  Object.assign(counters, { flights: 0, joins: 0, cacheHits: 0, cacheStores: 0, direct: 0 });
  logger.info(
    `Write preflight coalescing: ${effectiveConfig.coalescing ? 'on' : 'off'}, ` +
    `result cache: ${effectiveConfig.cacheTtlMs > 0 ? `on (${effectiveConfig.cacheTtlMs} ms)` : 'off'}, ` +
    `unresolved-write window: ${describeUnresolvedWriteWindow(effectiveConfig.unresolvedWriteWindowMs)} ` +
    `(${WRITE_PREFLIGHT_COALESCING_ENV}, ${WRITE_PREFLIGHT_CACHE_ENV}, ${WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_ENV}; ` +
    'effective until daemon restart)',
  );
  return effectiveConfig;
}

export function getWritePreflightCoalescingConfig(): WritePreflightCoalescingConfig {
  return effectiveConfig;
}

/**
 * What the coalescer has done since the daemon started (the `preflight_*` figures of the
 * `async_admission_usage` line). Every call of `probeWritePreflight` is counted exactly once, as a
 * start, a join, a cache hit or a direct probe, so `joins / (flights + joins + cacheHits + direct)` is
 * the share of preflights that did not read the store themselves.
 */
export interface WritePreflightCoalescingCounters {
  /** Probes started for a call that could be coalesced: the reads the store was actually asked for. */
  flights: number;
  /** Calls that joined a probe already in flight. */
  joins: number;
  /** Calls answered from the result cache. */
  cacheHits: number;
  /** Fast-accepted probes kept in the result cache (a probe shared by several callers is kept once). */
  cacheStores: number;
  /** Calls probed outright: coalescing off, or the agent gave no identity (also while a policy write's outcome is unknown). */
  direct: number;
}

const counters: WritePreflightCoalescingCounters = { flights: 0, joins: 0, cacheHits: 0, cacheStores: 0, direct: 0 };

export function getWritePreflightCoalescingCounters(): Readonly<WritePreflightCoalescingCounters> {
  return { ...counters };
}

type Probe = ContextGraphWritePreflightProbe;

/** What the daemon asks of the agent: the probe itself, and optionally the identity that lets calls share it. */
export interface CoalescingProbeAgent {
  probeContextGraphWritePreflight: (
    contextGraphId: string,
    opts?: { callerAgentAddress?: string | null; onChainLookup?: () => void },
  ) => Promise<Probe>;
  writePreflightIdentity?: (
    contextGraphId: string,
    callerAgentAddress?: string | null,
  ) => { readonly key: string; readonly stamp: string } | undefined;
}

/** Whether `agent` offers the probe, so that it can be coalesced (a narrow provider may not). */
export function canProbeWritePreflight(agent: Partial<CoalescingProbeAgent>): agent is CoalescingProbeAgent {
  return typeof agent.probeContextGraphWritePreflight === 'function';
}

/** Milliseconds on a monotonic clock: only differences between two of its readings mean anything. */
export type MonotonicClockMs = () => number;

const monotonicNowMs: MonotonicClockMs = () => performance.now();

/**
 * Whether something begun at `startedAt` is younger than `limitMs`. A negative age means the clock went backwards
 * (`performance.now` never does; an injected clock might), and that is never taken for a young one.
 */
function isYoungerThan(startedAt: number, now: number, limitMs: number): boolean {
  const age = now - startedAt;
  return age >= 0 && age < limitMs;
}

interface Flight {
  readonly id: number;
  readonly stamp: string;
  /** On the monotonic clock. */
  readonly startedAt: number;
  /** The probe consulted the chain, so its answer can change without a local write. */
  chainDerived: boolean;
  promise: Promise<Probe>;
}

interface CachedProbe {
  /** The probe the entry was kept from: callers that shared it keep the one entry, which is counted once. */
  readonly flightId: number;
  readonly stamp: string;
  /** When the probe began, on the monotonic clock. */
  readonly startedAt: number;
  readonly probe: Probe;
}

interface AgentState {
  readonly flights: Map<string, Flight>;
  readonly cache: Map<string, CachedProbe>;
}

const states = new WeakMap<object, AgentState>();
let nextFlightId = 0;

function stateOf(agent: object): AgentState {
  let state = states.get(agent);
  if (state === undefined) {
    state = { flights: new Map(), cache: new Map() };
    states.set(agent, state);
  }
  return state;
}

/**
 * Every caller gets its own copy, so none can change what another reads. The copy is made of the declared Probe
 * model and nothing else: its scalars, its two subscription records and its failure-attribution records are
 * copied field by field, so no object is shared between callers whatever a probe carries, and a member outside
 * the model is not handed on. Naming every declared field below is checked by the compiler: a field added to the
 * model leaves `undeclared` non-empty and this function stops compiling until the new field is copied here.
 */
function copyProbe(probe: Probe): Probe {
  const {
    storeAvailable, exists, hasLocalContent, inMemorySubscription, persistedSubscription, declarationFound,
    accessPolicy, curator, callerAuthorized, storeUnavailable, storeErrorMessage, failureAttribution, locallyCreated,
    ...undeclared
  } = probe;
  const allFieldsCopied: keyof typeof undeclared extends never ? true : never = true;
  void allFieldsCopied;
  // A field the probe did not set stays unset, as in the probe itself.
  return {
    storeAvailable,
    ...(locallyCreated !== undefined ? { locallyCreated } : {}),
    ...(exists !== undefined ? { exists } : {}),
    ...(hasLocalContent !== undefined ? { hasLocalContent } : {}),
    ...(inMemorySubscription !== undefined
      ? { inMemorySubscription: { subscribed: inMemorySubscription.subscribed, synced: inMemorySubscription.synced } }
      : {}),
    ...(persistedSubscription !== undefined
      ? { persistedSubscription: { subscribed: persistedSubscription.subscribed, synced: persistedSubscription.synced } }
      : {}),
    ...(declarationFound !== undefined ? { declarationFound } : {}),
    ...(accessPolicy !== undefined ? { accessPolicy } : {}),
    ...(curator !== undefined ? { curator } : {}),
    ...(callerAuthorized !== undefined ? { callerAuthorized } : {}),
    ...(storeUnavailable !== undefined ? { storeUnavailable } : {}),
    ...(storeErrorMessage !== undefined ? { storeErrorMessage } : {}),
    ...(failureAttribution !== undefined
      ? { failureAttribution: failureAttribution.map(({ site, kind }) => ({ site, kind })) }
      : {}),
  };
}

function identityOf(agent: CoalescingProbeAgent, contextGraphId: string, caller: string | null) {
  // The optimization must never be the reason a write is refused: without an identity, probe directly.
  try {
    return agent.writePreflightIdentity?.(contextGraphId, caller);
  } catch {
    return undefined;
  }
}

export interface CoalescedProbe {
  readonly probe: Probe;
  /**
   * The caller's decision on `probe` was a fast accept. When the cache is on, `probe` may be kept and served to
   * this caller again; otherwise nothing happens.
   */
  readonly fastAccepted: () => void;
}

const noop = (): void => {};

/**
 * Probes `contextGraphId` for `callerAgentAddress`, joining a probe already in flight for the same
 * identity.
 *
 * `accepts` is the caller's fast-accept decision, applied to a probe the cache would serve, so that the cache
 * serves only what this caller would fast-accept. `fresh` (the second pass after a readiness wait) neither joins
 * nor reads the cache: that pass exists to see what changed while it waited, which the stamp does not cover
 * (content that arrived). `now` is the monotonic clock in milliseconds, `performance.now` unless a test supplies one.
 */
export async function probeWritePreflight(
  agent: CoalescingProbeAgent,
  contextGraphId: string,
  callerAgentAddress: string | null,
  options: { accepts: (probe: Probe) => boolean; fresh?: boolean; now?: MonotonicClockMs },
): Promise<CoalescedProbe> {
  const config = effectiveConfig;
  const identity = config.coalescing ? identityOf(agent, contextGraphId, callerAgentAddress) : undefined;
  if (identity === undefined) {
    counters.direct += 1;
    return { probe: await agent.probeContextGraphWritePreflight(contextGraphId, { callerAgentAddress }), fastAccepted: noop };
  }

  const state = stateOf(agent);
  const now = (options.now ?? monotonicNowMs)();

  if (options.fresh !== true && config.cacheTtlMs > 0) {
    const hit = state.cache.get(identity.key);
    if (hit !== undefined) {
      if (hit.stamp !== identity.stamp || !isYoungerThan(hit.startedAt, now, config.cacheTtlMs)) state.cache.delete(identity.key);
      else if (options.accepts(hit.probe)) {
        counters.cacheHits += 1;
        return { probe: copyProbe(hit.probe), fastAccepted: noop };
      }
    }
  }

  let flight = options.fresh === true ? undefined : state.flights.get(identity.key);
  if (flight === undefined || flight.stamp !== identity.stamp || !isYoungerThan(flight.startedAt, now, WRITE_PREFLIGHT_FLIGHT_MAX_JOIN_MS)) {
    const started: Flight = { id: nextFlightId += 1, stamp: identity.stamp, startedAt: now, chainDerived: false, promise: undefined as unknown as Promise<Probe> };
    // A synchronous throw of the probe call becomes the flight's rejection, as for a rejected promise.
    started.promise = new Promise<Probe>((resolve) => resolve(agent.probeContextGraphWritePreflight(contextGraphId, {
      callerAgentAddress,
      onChainLookup: () => { started.chainDerived = true; },
    }))).finally(() => {
      // A newer flight may have taken the key; only the flight that holds it releases it.
      if (state.flights.get(identity.key) === started) state.flights.delete(identity.key);
    });
    state.flights.set(identity.key, started);
    counters.flights += 1;
    flight = started;
  } else {
    counters.joins += 1;
  }

  const joined = flight;
  const shared = await joined.promise;
  return {
    probe: copyProbe(shared),
    fastAccepted: () => {
      if (config.cacheTtlMs <= 0 || joined.chainDerived) return;
      if (shared.storeAvailable === false || shared.storeUnavailable === true) return;
      // Kept under the stamp it began with: a policy write or subscription change after that, even one that landed
      // while the probe ran, makes the entry a miss.
      if (state.cache.get(identity.key)?.flightId !== joined.id) counters.cacheStores += 1;
      state.cache.delete(identity.key);
      state.cache.set(identity.key, { flightId: joined.id, stamp: joined.stamp, startedAt: joined.startedAt, probe: copyProbe(shared) });
      while (state.cache.size > WRITE_PREFLIGHT_CACHE_MAX_ENTRIES) {
        const oldest = state.cache.keys().next();
        if (oldest.done) break;
        state.cache.delete(oldest.value);
      }
    },
  };
}
