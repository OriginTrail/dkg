import { availableParallelism } from 'node:os';
import { backpressureRegistry } from '@origintrail-official/dkg-core';
import {
  externalStorePriorityScheduler,
  StorePriorityScheduler,
  storeTimeoutDiagnosticSink,
} from './store-priority-scheduler.js';
import { registerStoreSchedulerStats } from './store-scheduler-stats.js';
import type { QueryOptions, StoreControlQueue } from './triple-store.js';

/**
 * The control path (OT-RFC-73 S1): the async share and publisher queues' own store calls run on two small
 * schedulers of their own, beside the shared one, so they never wait behind client reads or data-plane work.
 *
 * - One instance per queue, built only for a queue whose configured slots are above 0, once per process.
 *   Its slots are on top of the shared scheduler's; the ACK, health, normal and background gates never see
 *   control work and keep all of today's capacity.
 * - A call reaches its queue's instance by `QueryOptions.controlQueue` (see `controlStoreOptions`) and
 *   nothing else: no priority and no ambient lane moves a call there or away from it.
 * - With the path off nothing is built or registered, and a tagged call resolves exactly like an untagged one.
 * - Configuration is read once, so a change needs a restart. The setting is `DKG_STORE_CONTROL_RESERVED_SLOTS` when it
 *   is set, else the node config's `store.controlReservedSlots`, else the default (on only for Blazegraph on more than
 *   2 CPUs, OT-RFC-73 P14). Only the daemon passes the config value and the backend (`configureStoreControlPath`,
 *   before anything builds the path); any other process that imports this package honours the environment variable
 *   alone and otherwise keeps the path off, which is today's lane choice exactly.
 */
export const STORE_CONTROL_QUEUES: readonly StoreControlQueue[] = Object.freeze(['share', 'publisher']);

/** The most slots each queue's instance may ever have (its cap); configuration can lower it, never raise it. */
export const STORE_CONTROL_MAX_SLOTS: Readonly<Record<StoreControlQueue, number>> = Object.freeze({
  share: 1,
  publisher: 2,
});

export type StoreControlSlots = Readonly<Record<StoreControlQueue, number>>;

export const STORE_CONTROL_RESERVED_SLOTS_ENV = 'DKG_STORE_CONTROL_RESERVED_SLOTS';

/** The node config key beside the environment variable (`config.json`: `"store": { "controlReservedSlots": ... }`). */
export const STORE_CONTROL_RESERVED_SLOTS_CONFIG_KEY = 'store.controlReservedSlots';

/** A control instance registers under this prefix plus its queue (`store-control-share`). */
export const STORE_CONTROL_SCHEDULER_ID_PREFIX = 'store-control-';

/** Hosts with this many CPUs or fewer get no added slots by default until small hosts are qualified. */
const SMALL_HOST_CPUS = 2;

/**
 * The store backends (the node config's `store.backend`) whose nodes have the path on when nothing sets it
 * (OT-RFC-73 P14): Blazegraph only. Managed `oxigraph-server` (D-14), `sparql-http` (a Blazegraph reached through
 * it included) and every other backend keep it off by default until their own G2 cell passes; adding a backend here
 * is that change. `defaultStoreControlSlots` applies the small-host rule on top.
 */
export const STORE_CONTROL_DEFAULT_BACKENDS: readonly string[] = Object.freeze(['blazegraph']);

/** The embedded backends run no store scheduler, so the path never applies to them, whatever its setting. */
const EMBEDDED_BACKENDS: ReadonlySet<string> = new Set(['oxigraph', 'oxigraph-persistent', 'oxigraph-worker']);

const NO_SLOTS: StoreControlSlots = Object.freeze({ share: 0, publisher: 0 });

/**
 * The slots the default gives a node with store backend `backend` on a host with `cpus` CPUs: the S1 geometry
 * (share 1, publisher 2) for a default backend on more than 2 CPUs, otherwise none. No backend, as in a process
 * that never configured the path, means none.
 */
export function defaultStoreControlSlots(cpus: number, backend?: string): StoreControlSlots {
  const onByDefault = backend !== undefined && STORE_CONTROL_DEFAULT_BACKENDS.includes(backend);
  return onByDefault && cpus > SMALL_HOST_CPUS ? STORE_CONTROL_MAX_SLOTS : NO_SLOTS;
}

export interface StoreControlConfig {
  slots: StoreControlSlots;
  /** The setting that decided. `refused` is a malformed value (`reason` names its setting): the path is off, as for `0`. */
  source: 'default' | 'env' | 'config' | 'refused';
  /** That setting and its value, or the default and what decided it, as the startup line states it. */
  reason: string;
  warnings: string[];
}

export interface StoreControlResolveOptions {
  /** The host's CPUs (default: `availableParallelism()`); only the default reads it. */
  cpus?: number;
  /** The node config's `store.backend`; undefined in a process that never configured the path. */
  backend?: string;
  /** The node config's `store.controlReservedSlots` as read; undefined when the key is absent. */
  configured?: unknown;
}

const CONFIG_SETTING = `config ${STORE_CONTROL_RESERVED_SLOTS_CONFIG_KEY}`;

function refusedSetting(setting: string, shown: string, expected: string): StoreControlConfig {
  return {
    slots: NO_SLOTS,
    source: 'refused',
    reason: `${setting} refused as malformed`,
    warnings: [`Invalid ${setting}=${shown}; expected ${expected} or per-queue values such as "share:1,publisher:2". `
      + 'The control path stays off.'],
  };
}

/** One setting's text: `0`, or per-queue values. Malformed (blank included) is refused, never a fall-through. */
function parseStoreControlSetting(raw: string, setting: string, source: 'env' | 'config', expected: string): StoreControlConfig {
  const text = raw.trim();
  const refused = (): StoreControlConfig =>
    refusedSetting(setting, `${JSON.stringify(text.slice(0, 64))}${text ? '' : ' (set but blank)'}`, expected);
  if (!text) return refused();
  if (text === '0') return { slots: NO_SLOTS, source, reason: `${setting}=0`, warnings: [] };
  const slots: Record<StoreControlQueue, number> = { share: 0, publisher: 0 };
  const warnings: string[] = [];
  const seen = new Set<StoreControlQueue>();
  for (const entry of text.split(',')) {
    const match = /^\s*(share|publisher)\s*:\s*(\d+)\s*$/i.exec(entry);
    if (!match) return refused();
    const queue = match[1].toLowerCase() as StoreControlQueue;
    if (seen.has(queue)) return refused();
    seen.add(queue);
    const requested = Number(match[2]);
    slots[queue] = Math.min(requested, STORE_CONTROL_MAX_SLOTS[queue]);
    if (requested > STORE_CONTROL_MAX_SLOTS[queue]) {
      warnings.push(`${setting} ${queue}:${requested} is above the cap of ${STORE_CONTROL_MAX_SLOTS[queue]}; using ${slots[queue]}.`);
    }
  }
  return { slots, source, reason: `${setting}=${text}`, warnings };
}

/**
 * Resolve the effective slots. Precedence: `DKG_STORE_CONTROL_RESERVED_SLOTS` when it is set, else the node config's
 * `store.controlReservedSlots` when it is present, else the default (`defaultStoreControlSlots`, which needs the
 * backend). Both settings take the same values: per-queue values (`share:1,publisher:2`; a queue left out gets 0),
 * or `0` for the whole path off (in the config also the number 0). A value above a queue's cap is clamped with a
 * warning. A malformed value from either setting is refused with a warning that names the setting, and leaves the
 * path off: it never falls through to the other setting or the default, so a mistyped rollback can never leave the
 * path on. A variable that is set but blank (empty or only whitespace) is malformed too, not "unset"; in the config
 * only an absent key means the default (`null` is malformed). An explicit value may enable slots on any host and
 * with any backend, small hosts included.
 */
export function resolveStoreControlConfig(
  raw: string | undefined,
  options: StoreControlResolveOptions = {},
): StoreControlConfig {
  const { backend, configured } = options;
  if (raw !== undefined) {
    const resolved = parseStoreControlSetting(raw, STORE_CONTROL_RESERVED_SLOTS_ENV, 'env', '"0"');
    return configured === undefined ? resolved : { ...resolved, reason: `${resolved.reason}, over ${CONFIG_SETTING}` };
  }
  if (configured !== undefined) {
    if (configured === 0) return { slots: NO_SLOTS, source: 'config', reason: `${CONFIG_SETTING}=0`, warnings: [] };
    if (typeof configured === 'string') return parseStoreControlSetting(configured, CONFIG_SETTING, 'config', '0, "0"');
    return refusedSetting(CONFIG_SETTING, String(JSON.stringify(configured) ?? configured).slice(0, 64), '0, "0"');
  }
  const cpus = options.cpus ?? availableParallelism();
  const reason = backend === undefined ? 'default: no store backend configured'
    : !STORE_CONTROL_DEFAULT_BACKENDS.includes(backend) ? `default for ${backend}`
      : cpus > SMALL_HOST_CPUS ? `default for ${backend}, ${cpus} CPUs`
        : `default: ${SMALL_HOST_CPUS} CPUs or fewer (${backend}, ${cpus} CPUs)`;
  return { slots: defaultStoreControlSlots(cpus, backend), source: 'default', reason, warnings: [] };
}

/** Each queue's own scheduler; a queue without slots has none. */
export type StoreControlPath = Readonly<Partial<Record<StoreControlQueue, StorePriorityScheduler>>>;

/**
 * Build the instances for `slots`. Every capacity option is explicit, so no shared-scheduler environment tuning
 * and no class default reaches them: no ACK, health, normal or background reserve (a default ACK reserve would
 * hold one of the publisher's two slots), and the shared scheduler's resolved queue limit and wait as values.
 * Registration with the diagnostics is `registerStoreControlPath`'s job.
 * @internal Exported for tests and the daemon wiring; not part of the package's supported API.
 */
export function buildStoreControlPath(
  slots: StoreControlSlots,
  shared: Pick<StorePriorityScheduler, 'snapshot'> = externalStorePriorityScheduler,
): StoreControlPath {
  const { normalQueueLimit, queueWaitTimeoutMs } = shared.snapshot;
  const path: Partial<Record<StoreControlQueue, StorePriorityScheduler>> = {};
  for (const queue of STORE_CONTROL_QUEUES) {
    const maxConcurrent = Math.min(slots[queue], STORE_CONTROL_MAX_SLOTS[queue]);
    if (!(maxConcurrent > 0)) continue;
    path[queue] = new StorePriorityScheduler({
      controlId: `${STORE_CONTROL_SCHEDULER_ID_PREFIX}${queue}`,
      maxConcurrent,
      ackReservedSlots: 0,
      healthReservedSlots: 0,
      normalReservedSlots: 0,
      backgroundReservedSlots: 0,
      queueLimits: normalQueueLimit,
      queueWaitTimeoutMs,
      timeoutDiagnosticSink: storeTimeoutDiagnosticSink,
    });
  }
  return Object.freeze(path);
}

/**
 * Make the instances visible to the backpressure registry and the queue-wait stats; returns the undo.
 * If any registration throws, the ones already made are undone before the error propagates.
 * @internal Exported for tests; not part of the package's supported API.
 */
export function registerStoreControlPath(path: StoreControlPath): () => void {
  const undo: Array<() => void> = [];
  try {
    for (const scheduler of Object.values(path)) {
      // Two steps: if the second throws, the first's undo has already been recorded and the catch runs it.
      undo.push(backpressureRegistry.register(scheduler));
      undo.push(registerStoreSchedulerStats(scheduler));
    }
  } catch (error) {
    for (const fn of undo) fn();
    throw error;
  }
  return () => { for (const fn of undo) fn(); };
}

/** What the daemon gives the path before anything builds it (`configureStoreControlPath`). */
export interface StoreControlPathSettings {
  /** The node config's `store.backend` as configured (`oxigraph-server`, not its runtime `sparql-http` view). */
  backend: string | undefined;
  /** The node config's `store.controlReservedSlots` as read; undefined when the key is absent. */
  configured?: unknown;
}

interface ResolvedControlPath {
  config: StoreControlConfig;
  path: StoreControlPath;
  unregister: () => void;
  warningsReported: boolean;
  /** The settings the path was built with; undefined for a process that never configured it. */
  settings: StoreControlPathSettings | undefined;
}

let settings: StoreControlPathSettings | undefined;
let resolved: ResolvedControlPath | undefined;

const shownSetting = (value: unknown): string => (value === undefined ? 'absent' : String(JSON.stringify(value) ?? value).slice(0, 64));

function resolveControlPath(): ResolvedControlPath {
  if (!resolved) {
    const config = resolveStoreControlConfig(process.env[STORE_CONTROL_RESERVED_SLOTS_ENV], {
      backend: settings?.backend,
      configured: settings?.configured,
    });
    const path = buildStoreControlPath(config.slots);
    let unregister = (): void => undefined;
    try {
      unregister = registerStoreControlPath(path);
    } catch (error) {
      // The diagnostics are observability only; a second copy of the storage package must not break admission.
      console.warn(`[store control] not registered with the diagnostics: ${error instanceof Error ? error.message : String(error)}`);
    }
    resolved = { config, path, unregister, warningsReported: false, settings };
  }
  return resolved;
}

/**
 * Give the process-wide path the node's store backend and its `store.controlReservedSlots` value, which decide the
 * default and the config setting (`resolveStoreControlConfig`). The daemon calls this once at start, before any
 * store call can build the path, and logs the geometry right after (`logStoreControlPathGeometry`). The path is built
 * once and then holds work, so a call after it was built cannot change it: unless it repeats the settings the path
 * was built with, the call is refused with a warning and returns false. A process that never calls this (a
 * standalone tool, a benchmark, a test) has no backend and no config value, so only `DKG_STORE_CONTROL_RESERVED_SLOTS`
 * can turn its path on; otherwise it keeps today's lanes.
 */
export function configureStoreControlPath(
  next: StoreControlPathSettings,
  logger: { warn(message: string): void } = { warn: (message) => console.warn(`[store control] ${message}`) },
): boolean {
  const wanted: StoreControlPathSettings = { backend: next.backend, configured: next.configured };
  if (resolved) {
    const built = resolved.settings;
    if (built && built.backend === wanted.backend && shownSetting(built.configured) === shownSetting(wanted.configured)) return true;
    logger.warn(
      `Store control path: configuration refused, the path was already built (${resolved.config.reason}). `
      + `Backend ${wanted.backend ?? 'unset'} and ${STORE_CONTROL_RESERVED_SLOTS_CONFIG_KEY} ${shownSetting(wanted.configured)} `
      + 'take effect only after a restart.',
    );
    return false;
  }
  settings = wanted;
  return true;
}

/** The process-wide path, built on first use from the environment and, in the daemon, the configured settings. */
export function getStoreControlPath(): StoreControlPath {
  const state = resolveControlPath();
  if (!state.warningsReported) {
    state.warningsReported = true;
    for (const warning of state.config.warnings) console.warn(`[store control] ${warning}`);
  }
  return state.path;
}

/**
 * Test injection point. Replaces the process-wide path with `path` (injected instances are not registered), or
 * with nothing, which returns the process to the unconfigured state (built from the environment alone on next use);
 * either way the previous path's registrations are undone and any configured settings are cleared.
 * @internal Test hook; not part of the package's supported API.
 */
export function setStoreControlPathForTesting(path?: StoreControlPath): void {
  resolved?.unregister();
  resolved = undefined;
  settings = undefined;
  if (!path) return;
  const slots = { share: 0, publisher: 0 };
  for (const queue of STORE_CONTROL_QUEUES) slots[queue] = path[queue]?.snapshot.maxConcurrent ?? 0;
  resolved = {
    config: { slots, source: 'env', reason: 'set for testing', warnings: [] },
    path,
    unregister: () => undefined,
    warningsReported: true,
    settings: undefined,
  };
}

/**
 * The scheduler an adapter runs a call on: the call's queue instance when that path is on and
 * `options.controlQueue` names it, otherwise `shared`. Nothing else about the call picks the instance.
 */
export function selectStoreScheduler(
  shared: StorePriorityScheduler,
  options: Pick<QueryOptions, 'controlQueue'> | undefined,
): StorePriorityScheduler {
  const queue = options?.controlQueue;
  if (queue === undefined) return shared;
  const path = getStoreControlPath();
  return (queue === 'share' ? path.share : queue === 'publisher' ? path.publisher : undefined) ?? shared;
}

/** Options for a queue's control call: its source label and queue, and no priority. */
export function controlStoreOptions(
  queue: StoreControlQueue,
  source: string,
): QueryOptions & { source: string; controlQueue: StoreControlQueue } {
  return { source, controlQueue: queue };
}

/** The one-line description of the effective geometry and the setting that decided it, as logged at daemon start. */
export function describeStoreControlPath(): string {
  const { config, path, settings: built } = resolveControlPath();
  const slots = STORE_CONTROL_QUEUES.map((queue) => `${queue}=${path[queue]?.snapshot.maxConcurrent ?? 0}`).join(' ');
  const on = STORE_CONTROL_QUEUES.some((queue) => path[queue] !== undefined);
  const backend = built?.backend;
  const unused = backend !== undefined && EMBEDDED_BACKENDS.has(backend) ? `; the embedded ${backend} store never uses it` : '';
  return `Store control path: ${on ? 'on' : 'off'} (added slots ${slots}; ${config.reason}${unused}; effective until daemon restart)`;
}

/**
 * Log the effective geometry once at daemon start, with any warning about the configured value. Called from
 * the daemon right after `configureStoreControlPath` (not at import, which would print it in every process that
 * imports the storage package); it also builds the instances if nothing has, so they show in the diagnostics from
 * the start.
 */
export function logStoreControlPathGeometry(logger: { info(message: string): void; warn(message: string): void }): void {
  const state = resolveControlPath();
  if (!state.warningsReported) {
    state.warningsReported = true;
    for (const warning of state.config.warnings) logger.warn(warning);
  }
  logger.info(describeStoreControlPath());
}
