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
 * - Configuration is read once, so a change needs a restart.
 */
export const STORE_CONTROL_QUEUES: readonly StoreControlQueue[] = Object.freeze(['share', 'publisher']);

/** The most slots each queue's instance may ever have (its cap); configuration can lower it, never raise it. */
export const STORE_CONTROL_MAX_SLOTS: Readonly<Record<StoreControlQueue, number>> = Object.freeze({
  share: 1,
  publisher: 2,
});

export type StoreControlSlots = Readonly<Record<StoreControlQueue, number>>;

export const STORE_CONTROL_RESERVED_SLOTS_ENV = 'DKG_STORE_CONTROL_RESERVED_SLOTS';

/** A control instance registers under this prefix plus its queue (`store-control-share`). */
export const STORE_CONTROL_SCHEDULER_ID_PREFIX = 'store-control-';

/** Hosts with this many CPUs or fewer get no added slots by default until small hosts are qualified. */
const SMALL_HOST_CPUS = 2;

/**
 * Whether an unset `DKG_STORE_CONTROL_RESERVED_SLOTS` turns the path on. The slot code ships switched off,
 * so this is false; the default flip changes this one value, and `defaultStoreControlSlots` applies the
 * small-host rule from there.
 */
export const STORE_CONTROL_PATH_ON_BY_DEFAULT = false;

const NO_SLOTS: StoreControlSlots = Object.freeze({ share: 0, publisher: 0 });

/** The slots an unset environment value means on a host with `cpus` CPUs. */
export function defaultStoreControlSlots(
  cpus: number,
  onByDefault: boolean = STORE_CONTROL_PATH_ON_BY_DEFAULT,
): StoreControlSlots {
  return onByDefault && cpus > SMALL_HOST_CPUS ? STORE_CONTROL_MAX_SLOTS : NO_SLOTS;
}

export interface StoreControlConfig {
  slots: StoreControlSlots;
  /** `refused` is a malformed value: the path is off, as for `0`. */
  source: 'default' | 'env' | 'refused';
  warnings: string[];
}

/**
 * Resolve `DKG_STORE_CONTROL_RESERVED_SLOTS`: per-queue values (`share:1,publisher:2`; a queue left out gets 0),
 * `0` for the whole path off, or an unset variable for the default. A value above a queue's cap is clamped with a
 * warning. A malformed value is refused with a warning and leaves the path off, so a mistyped rollback can never
 * leave it on; a variable that is set but blank (empty or only whitespace) is malformed too, not "unset", so it
 * never means the default. An explicit value may enable slots on any host, small ones included.
 */
export function resolveStoreControlConfig(
  raw: string | undefined,
  options: { cpus?: number; onByDefault?: boolean } = {},
): StoreControlConfig {
  if (raw === undefined) {
    return {
      slots: defaultStoreControlSlots(options.cpus ?? availableParallelism(), options.onByDefault),
      source: 'default',
      warnings: [],
    };
  }
  const text = raw.trim();
  const refused = (): StoreControlConfig => ({
    slots: NO_SLOTS,
    source: 'refused',
    warnings: [
      `Invalid ${STORE_CONTROL_RESERVED_SLOTS_ENV}=${JSON.stringify(text.slice(0, 64))}`
      + `${text ? '' : ' (set but blank)'}; expected "0" or per-queue values such as "share:1,publisher:2". `
      + 'The control path stays off.',
    ],
  });
  if (!text) return refused();
  if (text === '0') return { slots: NO_SLOTS, source: 'env', warnings: [] };
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
      warnings.push(
        `${STORE_CONTROL_RESERVED_SLOTS_ENV} ${queue}:${requested} is above the cap of `
        + `${STORE_CONTROL_MAX_SLOTS[queue]}; using ${slots[queue]}.`,
      );
    }
  }
  return { slots, source: 'env', warnings };
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

interface ResolvedControlPath {
  config: StoreControlConfig;
  path: StoreControlPath;
  unregister: () => void;
  warningsReported: boolean;
}

let resolved: ResolvedControlPath | undefined;

function resolveControlPath(): ResolvedControlPath {
  if (!resolved) {
    const config = resolveStoreControlConfig(process.env[STORE_CONTROL_RESERVED_SLOTS_ENV]);
    const path = buildStoreControlPath(config.slots);
    let unregister = (): void => undefined;
    try {
      unregister = registerStoreControlPath(path);
    } catch (error) {
      // The diagnostics are observability only; a second copy of the storage package must not break admission.
      console.warn(`[store control] not registered with the diagnostics: ${error instanceof Error ? error.message : String(error)}`);
    }
    resolved = { config, path, unregister, warningsReported: false };
  }
  return resolved;
}

/** The process-wide path, built from the environment on first use. */
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
 * with nothing to build it from the environment again; either way the previous path's registrations are undone.
 * @internal Test hook; not part of the package's supported API.
 */
export function setStoreControlPathForTesting(path?: StoreControlPath): void {
  resolved?.unregister();
  resolved = undefined;
  if (!path) return;
  const slots = { share: 0, publisher: 0 };
  for (const queue of STORE_CONTROL_QUEUES) slots[queue] = path[queue]?.snapshot.maxConcurrent ?? 0;
  resolved = {
    config: { slots, source: 'env', warnings: [] },
    path,
    unregister: () => undefined,
    warningsReported: true,
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

/** The one-line description of the effective geometry, as logged at daemon start. */
export function describeStoreControlPath(): string {
  const { config, path } = resolveControlPath();
  const slots = STORE_CONTROL_QUEUES.map((queue) => `${queue}=${path[queue]?.snapshot.maxConcurrent ?? 0}`).join(' ');
  const on = STORE_CONTROL_QUEUES.some((queue) => path[queue] !== undefined);
  const why = config.source === 'refused' ? `${STORE_CONTROL_RESERVED_SLOTS_ENV} refused as malformed`
    : config.source === 'env' ? STORE_CONTROL_RESERVED_SLOTS_ENV
      : `default, ${availableParallelism()} CPUs`;
  return `Store control path: ${on ? 'on' : 'off'} (added slots ${slots}; ${why}; effective until daemon restart)`;
}

/**
 * Log the effective geometry once at daemon start, with any warning about the configured value. Called from
 * the daemon (not at import, which would print it in every process that imports the storage package); it also
 * builds the instances if nothing has, so they show in the diagnostics from the start.
 */
export function logStoreControlPathGeometry(logger: { info(message: string): void; warn(message: string): void }): void {
  const state = resolveControlPath();
  if (!state.warningsReported) {
    state.warningsReported = true;
    for (const warning of state.config.warnings) logger.warn(warning);
  }
  logger.info(describeStoreControlPath());
}
