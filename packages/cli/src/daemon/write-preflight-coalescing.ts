import type { ContextGraphWritePreflightProbe } from '@origintrail-official/dkg-agent';

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
 * exactly as before.
 *
 * Optionally (off by default) a probe that ended in a fast accept is kept for a short time and
 * served to the same caller again. It is never kept when it could be stale in a way the stamp does
 * not see: a store that was down, an answer that consulted the chain, a probe during which the stamp
 * moved. A negative answer is never kept either: it is cheaper to ask again than to keep a refusal
 * after the cause went away.
 */

/** Turns coalescing off (`0`, `false`, `no`, `off`) or on (the default). Applies after a daemon restart. */
export const WRITE_PREFLIGHT_COALESCING_ENV = 'DKG_WRITE_PREFLIGHT_COALESCING';
/** Turns the fast-accept result cache on (`1`, `true`, `yes`, `on`); off by default. It needs coalescing. */
export const WRITE_PREFLIGHT_CACHE_ENV = 'DKG_WRITE_PREFLIGHT_CACHE';
/** How long the result cache keeps a fast accept, in milliseconds. */
export const WRITE_PREFLIGHT_CACHE_TTL_ENV = 'DKG_WRITE_PREFLIGHT_CACHE_TTL_MS';

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
 * Reads the three variables. A value that is not recognized leaves its feature off, with a warning,
 * so that a mistyped rollback can never leave coalescing on and a mistyped opt-in never turns the
 * cache on. A TTL is clamped to its range, or falls back to the default when it is not a number.
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
    return { coalescing, cacheTtlMs: 0 };
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
  return { coalescing, cacheTtlMs };
}

let effectiveConfig: WritePreflightCoalescingConfig = { coalescing: true, cacheTtlMs: 0 };

/** Resolves the switches and logs the outcome once, at daemon start; a change needs a restart. */
export function configureWritePreflightCoalescing(
  env: Readonly<Record<string, string | undefined>>,
  logger: WritePreflightCoalescingLogger,
): WritePreflightCoalescingConfig {
  effectiveConfig = resolveWritePreflightCoalescingConfig(env, logger);
  logger.info(
    `Write preflight coalescing: ${effectiveConfig.coalescing ? 'on' : 'off'}, ` +
    `result cache: ${effectiveConfig.cacheTtlMs > 0 ? `on (${effectiveConfig.cacheTtlMs} ms)` : 'off'} ` +
    `(${WRITE_PREFLIGHT_COALESCING_ENV}, ${WRITE_PREFLIGHT_CACHE_ENV}; effective until daemon restart)`,
  );
  return effectiveConfig;
}

export function getWritePreflightCoalescingConfig(): WritePreflightCoalescingConfig {
  return effectiveConfig;
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

interface Flight {
  readonly stamp: string;
  readonly startedAt: number;
  /** The probe consulted the chain, so its answer can change without a local write. */
  chainDerived: boolean;
  promise: Promise<Probe>;
}

interface CachedProbe {
  readonly stamp: string;
  readonly startedAt: number;
  readonly probe: Probe;
}

interface AgentState {
  readonly flights: Map<string, Flight>;
  readonly cache: Map<string, CachedProbe>;
}

const states = new WeakMap<object, AgentState>();

function stateOf(agent: object): AgentState {
  let state = states.get(agent);
  if (state === undefined) {
    state = { flights: new Map(), cache: new Map() };
    states.set(agent, state);
  }
  return state;
}

/** Every caller gets its own copy, so none can change what another reads. */
function copyProbe(probe: Probe): Probe {
  try {
    return structuredClone(probe);
  } catch {
    return { ...probe };
  }
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
 * (content that arrived).
 */
export async function probeWritePreflight(
  agent: CoalescingProbeAgent,
  contextGraphId: string,
  callerAgentAddress: string | null,
  options: { accepts: (probe: Probe) => boolean; fresh?: boolean },
): Promise<CoalescedProbe> {
  const config = effectiveConfig;
  const identity = config.coalescing ? identityOf(agent, contextGraphId, callerAgentAddress) : undefined;
  if (identity === undefined) {
    return { probe: await agent.probeContextGraphWritePreflight(contextGraphId, { callerAgentAddress }), fastAccepted: noop };
  }

  const state = stateOf(agent);
  const now = Date.now();

  if (options.fresh !== true && config.cacheTtlMs > 0) {
    const hit = state.cache.get(identity.key);
    if (hit !== undefined) {
      const age = now - hit.startedAt;
      if (hit.stamp !== identity.stamp || age < 0 || age >= config.cacheTtlMs) state.cache.delete(identity.key);
      else if (options.accepts(hit.probe)) return { probe: copyProbe(hit.probe), fastAccepted: noop };
    }
  }

  let flight = options.fresh === true ? undefined : state.flights.get(identity.key);
  if (flight === undefined || flight.stamp !== identity.stamp || now - flight.startedAt >= WRITE_PREFLIGHT_FLIGHT_MAX_JOIN_MS) {
    const started: Flight = { stamp: identity.stamp, startedAt: now, chainDerived: false, promise: undefined as unknown as Promise<Probe> };
    // A synchronous throw of the probe call becomes the flight's rejection, as for a rejected promise.
    started.promise = new Promise<Probe>((resolve) => resolve(agent.probeContextGraphWritePreflight(contextGraphId, {
      callerAgentAddress,
      onChainLookup: () => { started.chainDerived = true; },
    }))).finally(() => {
      // A newer flight may have taken the key; only the flight that holds it releases it.
      if (state.flights.get(identity.key) === started) state.flights.delete(identity.key);
    });
    state.flights.set(identity.key, started);
    flight = started;
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
      state.cache.delete(identity.key);
      state.cache.set(identity.key, { stamp: joined.stamp, startedAt: joined.startedAt, probe: copyProbe(shared) });
      while (state.cache.size > WRITE_PREFLIGHT_CACHE_MAX_ENTRIES) {
        const oldest = state.cache.keys().next();
        if (oldest.done) break;
        state.cache.delete(oldest.value);
      }
    },
  };
}
