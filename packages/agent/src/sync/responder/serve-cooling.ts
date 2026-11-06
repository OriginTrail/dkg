// SPDX-License-Identifier: Apache-2.0
import { isStoreOperationTimeoutError } from '@origintrail-official/dkg-storage';
import { formatSyncNotServable, type SyncNotServableReason } from '../not-servable.js';
import { isSyncRowSnapshotPagingRequiredError } from './snapshot-cache.js';

/** First cooling period after a request shape could not be served. */
export const SYNC_RESPONDER_COOLING_BASE_MS = 10 * 60_000;
/** The period doubles with each consecutive failure up to this cap. */
export const SYNC_RESPONDER_COOLING_MAX_MS = 60 * 60_000;
const SYNC_RESPONDER_COOLING_MAX_ENTRIES = 256;

/**
 * What a request reads, as far as its cost is concerned. Two requests of one
 * shape run the same store work whoever asks, so the outcome of one says what
 * the next would cost; the requesting peer is deliberately not part of it.
 */
export interface SyncResponderRequestShape {
  readonly contextGraphId: string;
  readonly plane: 'durable' | 'shared-memory';
  readonly phase: string;
  /**
   * A whole-graph walk, a batch-id delta, or one exact asset selection (with
   * its selection key: what an exact request costs depends on its assets).
   */
  readonly selection: 'full' | 'delta' | `exact:${string}`;
  /**
   * Whether the request starts a walk or reads a later page of a session the
   * responder already holds state for. A start pays for building that state, a
   * continuation reads from it, so one failing says nothing about the other: a
   * start that cannot be served must not end the sessions that are being served.
   */
  readonly stage: 'start' | 'continuation';
}

export interface SyncResponderCoolingOptions {
  /** The handler's busy error: it owns how a refusal is counted, logged and sent. */
  readonly busyError: (message: string) => Error;
  readonly logWarn: (message: string) => void;
  readonly now?: () => number;
  readonly baseMs?: number;
  readonly maxMs?: number;
}

interface CoolingEntry {
  failures: number;
  reason: SyncNotServableReason;
  /** Order of the failure that set `until` among request starts and failures. */
  recordedTick: number;
  until: number;
}

/**
 * Why a failed request says something about its shape, or `undefined` when it
 * does not. A store query that ran into its deadline does: the same query
 * would run into it again. A store that was recovering or shedding work before
 * the query started does not, and neither does a caller that left.
 */
export function syncNotServableReasonOf(error: unknown): SyncNotServableReason | undefined {
  if (isSyncRowSnapshotPagingRequiredError(error)) return 'too-large';
  try {
    let current = error;
    for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
      if (isStoreOperationTimeoutError(current)) {
        const ranIntoDeadline = current.outcome !== 'not_started'
          && (typeof current.timeoutMs === 'number' || /\bdeadline\b/.test(current.message ?? ''));
        return ranIntoDeadline ? 'store-deadline' : undefined;
      }
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // An unreadable error shape is no evidence about the request.
  }
  return undefined;
}

/**
 * Remembers request shapes this responder could not serve and refuses them
 * without running them until a cooling period ends.
 *
 * A store query that runs into the store deadline is expensive for the whole
 * node, not only for its request, and the same request would end the same way.
 * So after one such failure the shape is refused for a period that doubles
 * with each consecutive failure; when a period ends requests run again, and
 * one that is served clears the record. A request beyond the paging bounds is
 * remembered the same way, which saves the bounded reads that would rediscover
 * it.
 *
 * The failing request itself keeps its own error and outcome. Only the
 * requests refused while cooling get the handler's ordinary busy reply, with
 * the not-servable text and the time left.
 */
export function createSyncResponderCooling(options: SyncResponderCoolingOptions) {
  const now = options.now ?? Date.now;
  const baseMs = options.baseMs ?? SYNC_RESPONDER_COOLING_BASE_MS;
  const maxMs = options.maxMs ?? SYNC_RESPONDER_COOLING_MAX_MS;
  const entries = new Map<string, CoolingEntry>();
  // Orders request starts against recorded failures. A clock cannot: requests
  // that overlap one failure may start and fail within the same millisecond.
  let tick = 0;
  const keyOf = (shape: SyncResponderRequestShape) =>
    JSON.stringify([shape.plane, shape.phase, shape.selection, shape.stage, shape.contextGraphId]);
  const prune = (at: number) => {
    // A record outlives its period so the next failure can extend it; one that
    // has not been probed for a whole cap is forgotten.
    for (const [key, entry] of entries) {
      if (at >= entry.until + maxMs) entries.delete(key);
    }
    while (entries.size > SYNC_RESPONDER_COOLING_MAX_ENTRIES) {
      entries.delete(entries.keys().next().value!);
    }
  };

  const record = (shape: SyncResponderRequestShape, key: string, startedTick: number, error: unknown) => {
    const reason = syncNotServableReasonOf(error);
    const failedAt = now();
    const recorded = entries.get(key);
    // A request that overlapped an already recorded failure is the same
    // evidence, not a further failure: it extends nothing.
    if (reason === undefined || (recorded && startedTick <= recorded.recordedTick)) return;
    const failures = (recorded?.failures ?? 0) + 1;
    const period = Math.min(baseMs * 2 ** Math.min(failures - 1, 30), maxMs);
    entries.delete(key);
    entries.set(key, { failures, reason, recordedTick: (tick += 1), until: failedAt + period });
    prune(failedAt);
    options.logWarn(
      `Sync responder will not run ${shape.plane} ${shape.phase} (${shape.selection}, ${shape.stage}) requests for `
      + `"${shape.contextGraphId}" for ${Math.round(period / 1000)}s: ${reason}, `
      + `${failures} in a row (${error instanceof Error ? error.message : String(error)})`,
    );
  };

  return {
    /**
     * Run `work` for a request of this shape, or refuse it while the shape
     * cools. `work` receives a reporter for a failure of work the request
     * started but may not wait for: session state goes on being built after
     * its request has left, and what ends that build is evidence all the same.
     */
    async run<T>(
      shape: SyncResponderRequestShape,
      work: (reportFailure: (error: unknown) => void) => Promise<T>,
    ): Promise<T> {
      const key = keyOf(shape);
      const startedAt = now();
      const cooling = entries.get(key);
      if (cooling && startedAt < cooling.until) {
        throw options.busyError(formatSyncNotServable(cooling.reason, cooling.until - startedAt));
      }
      const startedTick = (tick += 1);
      try {
        const result = await work((error) => record(shape, key, startedTick, error));
        // Served after the last recorded failure: nothing is held against the
        // shape. A request that was already running when that failure was
        // recorded says nothing about the requests after it.
        const recorded = entries.get(key);
        if (recorded && startedTick > recorded.recordedTick) entries.delete(key);
        return result;
      } catch (error) {
        record(shape, key, startedTick, error);
        throw error;
      }
    },
    /** Shapes cooling right now, for tests and diagnostics. */
    coolingCount(): number {
      const at = now();
      let count = 0;
      for (const entry of entries.values()) if (at < entry.until) count += 1;
      return count;
    },
  };
}

export type SyncResponderCooling = ReturnType<typeof createSyncResponderCooling>;
