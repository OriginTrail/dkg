// SPDX-License-Identifier: Apache-2.0
import { withOwnedRpcRequestContext } from '@origintrail-official/dkg-chain';
import { runBoundedOperation } from './bounded-operation.js';
import { resolveBooleanSwitch } from './sync/backpressure.js';
import { MAX_EXACT_SYNC_ASSETS } from './sync/exact-assets.js';
import {
  VM_RECOVERY_BRIDGE_ABORTED,
  VM_RECOVERY_BRIDGE_TIMED_OUT,
  VM_RECOVERY_FOOTPRINT_READ_TIMEOUT_MS,
  readVmRecoveryFootprintWithDeadline,
  vmRecoveryFootprintFromUpdateContext,
  type VmRecoveryFootprintSizingReader,
  type VmRecoveryPreparedHints,
} from './vm-recovery-footprint.js';
import type { VmRecoveryChainFootprint } from './vm-recovery-types.js';

/**
 * Advisory preparation of the NEXT recovery batch's sizing metadata.
 *
 * While one exact batch transfers and commits, this owner reads the update
 * context of a bounded stable prefix of the still-pending candidates, so the
 * next planning pass finds those hints ready instead of re-reading them (or
 * losing them to the local RPC governor's queue and truncating the batch).
 *
 * What it is NOT. A hint is planning evidence of exactly the kind a live
 * `latest-bounded` read yields: it can change how work is packed and nothing
 * else. It earns no holder credit, consumes no peer attempt, records no
 * admission, touches no negative cache and marks no ordinal handled, attempted,
 * reconciled or materialized. The chain root count/version/binding and the
 * guarded atomic write that follow authenticate every asset independently.
 *
 * Bounds. One prepared batch (at most {@link MAX_EXACT_SYNC_ASSETS} KAs) is
 * retained at a time; at most `maxSpeculativeReads` speculative reads are in
 * flight, each a single RPC in the BACKGROUND class bound to the owner's
 * signal; descriptors hold a handful of scalars (no quads or payloads) and are
 * byte-accounted. Hints are single-use and expire; a stale generation, a lost
 * recovery ownership or an abort turns every hint into a miss, and the caller's
 * live path runs unchanged.
 */
export const VM_RECOVERY_PREPARATION_LIMITS = Object.freeze({
  /** One future batch, never more than the exact-asset hard selector limit. */
  maxPreparedAssets: MAX_EXACT_SYNC_ASSETS,
  /** Speculative KA-read tasks in flight at once (each is one RPC). */
  maxSpeculativeReads: 2,
  /**
   * Per-read deadline of a speculative read. It runs off the critical path, so
   * it may wait out a busy local RPC governor longer than a planning read could.
   */
  readTimeoutMs: 2 * VM_RECOVERY_FOOTPRINT_READ_TIMEOUT_MS,
  /** A hint older than this at consumption is a miss. */
  maxHintAgeMs: 60_000,
  /** Explicit ceiling for retained descriptor memory. */
  maxRetainedBytes: 16 * 1024,
  /** Live planning reads in flight at once when preparation is enabled. */
  planningReadConcurrency: 3,
  /**
   * Deadline of a live planning read when preparation is enabled. Admission
   * wait in the local RPC governor counts inside it, and one unresolved first
   * candidate truncates the whole batch to a single asset, so a busy lane is
   * given longer than the unprepared path's limit before a read is abandoned.
   */
  planningReadTimeoutMs: 2 * VM_RECOVERY_FOOTPRINT_READ_TIMEOUT_MS,
  /**
   * Minimum spacing between reads of the registered-public observation that gates the
   * stream wire when an earlier read in the same pass was unavailable.
   */
  authorityRetryMinIntervalMs: 5_000,
});

export type VmRecoveryPreparationLimits = {
  -readonly [K in keyof typeof VM_RECOVERY_PREPARATION_LIMITS]: number;
};

/** The recovery operation a hint belongs to. */
export interface VmRecoveryPreparationScope {
  readonly localCgId: string;
  readonly onChainCgId: bigint;
  /** `vmReconcileLifecycleGeneration` at the time the owning pass started. */
  readonly generation: number;
  /** The recovery operation's cancellation signal. */
  readonly signal?: AbortSignal;
  /** Recovery ownership at call time (lifecycle, binding, target). */
  readonly isCurrent: () => boolean;
}

export interface VmRecoveryPreparationCandidate {
  readonly kaId: string;
  /** A footprint the caller already holds is retained as-is instead of re-read. */
  readonly footprint?: VmRecoveryChainFootprint;
}

export type VmRecoveryPrepareRefusal =
  | 'disabled' | 'closed' | 'stale-scope' | 'busy' | 'no-reader' | 'no-candidates';

export interface VmRecoveryPrepareResult {
  readonly accepted: number;
  readonly refused?: VmRecoveryPrepareRefusal;
}

/** Cumulative, bounded, secret-free counters. */
export interface VmRecoveryPreparationStats {
  readonly prepareCalls: number;
  readonly refused: number;
  /** Candidates accepted into a prepared batch. */
  readonly accepted: number;
  /** Speculative reads started / finished with a usable hint / ended without one. */
  readonly readsStarted: number;
  readonly readsReady: number;
  readonly readsUnusable: number;
  /** Hints handed to a consumer (single use). */
  readonly hits: number;
  /** Consumer lookups that found nothing usable. */
  readonly misses: number;
  readonly staleMisses: number;
  /** Prepared entries dropped without being consumed. */
  readonly discardedUnused: number;
  /** Speculative results that completed after their batch was gone. */
  readonly lateDropped: number;
  readonly maxActiveReads: number;
  readonly maxRetainedBytes: number;
  readonly retainedBytes: number;
  readonly activeReads: number;
}

type EntryState = 'queued' | 'reading' | 'ready' | 'unusable' | 'taken';

interface PreparedEntry {
  readonly kaId: string;
  state: EntryState;
  footprint?: VmRecoveryChainFootprint;
  bytes: number;
  settled?: Promise<void>;
}

interface PreparedBatch {
  readonly scope: VmRecoveryPreparationScope;
  readonly createdAt: number;
  readonly controller: AbortController;
  readonly entries: Map<string, PreparedEntry>;
  detachScopeSignal: () => void;
  released: boolean;
}

function entryBytes(kaId: string, footprint: VmRecoveryChainFootprint | undefined): number {
  // Fixed bookkeeping plus the string/bigint scalars the descriptor retains.
  const scalars = footprint?.kind === 'public-v10'
    ? footprint.assertionVersion.length + footprint.byteSize.toString().length
      + footprint.merkleLeafCount.toString().length
    : 0;
  return 96 + 2 * kaId.length + 2 * scalars;
}

/** Typed experimental switch: env `DKG_EXPERIMENTAL_VM_RECOVERY_PREFETCH`, then config, default off. */
export function resolveVmRecoveryPrefetchEnabled(configValue?: boolean): boolean {
  return resolveBooleanSwitch(configValue, 'DKG_EXPERIMENTAL_VM_RECOVERY_PREFETCH', false);
}

export class VmRecoveryPreparation {
  readonly #sizing: VmRecoveryFootprintSizingReader | null;
  readonly #limits: VmRecoveryPreparationLimits;
  readonly #now: () => number;
  #batch: PreparedBatch | undefined;
  #closed = false;
  #activeReads = 0;
  #retainedBytes = 0;
  /** Underlying reads that have been issued and have not yet physically settled. */
  readonly #physical = new Set<Promise<void>>();
  #counters = {
    prepareCalls: 0, refused: 0, accepted: 0, readsStarted: 0, readsReady: 0, readsUnusable: 0,
    hits: 0, misses: 0, staleMisses: 0, discardedUnused: 0, lateDropped: 0,
    maxActiveReads: 0, maxRetainedBytes: 0,
  };

  constructor(
    sizing: VmRecoveryFootprintSizingReader | null,
    limits: Partial<VmRecoveryPreparationLimits> = {},
    now: () => number = () => performance.now(),
  ) {
    this.#sizing = sizing;
    this.#limits = { ...VM_RECOVERY_PREPARATION_LIMITS, ...limits };
    this.#now = now;
  }

  get limits(): Readonly<VmRecoveryPreparationLimits> {
    return this.#limits;
  }

  /**
   * Begin preparing hints for a stable prefix of future candidates. Never
   * throws and never blocks; a refusal leaves the caller's live path intact.
   * No second batch is accepted until the first is consumed or discarded.
   */
  prepare(
    scope: VmRecoveryPreparationScope,
    candidates: readonly VmRecoveryPreparationCandidate[],
  ): VmRecoveryPrepareResult {
    this.#counters.prepareCalls += 1;
    const refuse = (refused: VmRecoveryPrepareRefusal): VmRecoveryPrepareResult => {
      this.#counters.refused += 1;
      return { accepted: 0, refused };
    };
    if (this.#closed) return refuse('closed');
    if (this.#sizing === null) return refuse('no-reader');
    if (scope.signal?.aborted || !this.#scopeIsCurrent(scope)) return refuse('stale-scope');
    const existing = this.#batch;
    if (existing && !existing.released && this.#batchIsDead(existing)) this.#dropBatch(existing, true);
    if (this.#batch && !this.#batch.released) return refuse('busy');

    const picked: VmRecoveryPreparationCandidate[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (picked.length >= this.#limits.maxPreparedAssets) break;
      if (!/^[0-9]+$/.test(candidate.kaId) || seen.has(candidate.kaId)) continue;
      seen.add(candidate.kaId);
      picked.push(candidate);
    }
    if (picked.length === 0) return refuse('no-candidates');

    const controller = new AbortController();
    const batch: PreparedBatch = {
      scope,
      createdAt: this.#now(),
      controller,
      entries: new Map(),
      detachScopeSignal: () => undefined,
      released: false,
    };
    if (scope.signal) {
      const onAbort = (): void => controller.abort(scope.signal?.reason);
      scope.signal.addEventListener('abort', onAbort, { once: true });
      batch.detachScopeSignal = () => scope.signal?.removeEventListener('abort', onAbort);
    }
    let retained = 0;
    for (const candidate of picked) {
      const ready = candidate.footprint?.kind === 'public-v10' ? candidate.footprint : undefined;
      const bytes = entryBytes(candidate.kaId, ready);
      if (this.#retainedBytes + retained + bytes > this.#limits.maxRetainedBytes) break;
      retained += bytes;
      batch.entries.set(candidate.kaId, {
        kaId: candidate.kaId,
        state: ready ? 'ready' : 'queued',
        ...(ready ? { footprint: ready } : {}),
        bytes,
      });
    }
    if (batch.entries.size === 0) {
      batch.detachScopeSignal();
      return refuse('no-candidates');
    }
    this.#batch = batch;
    this.#retainedBytes += retained;
    this.#counters.accepted += batch.entries.size;
    this.#counters.maxRetainedBytes = Math.max(this.#counters.maxRetainedBytes, this.#retainedBytes);
    this.#pump(batch);
    return { accepted: batch.entries.size };
  }

  /** Hints bound to `scope`, for the planner. Hints are single-use; see {@link release}. */
  hintsFor(scope: VmRecoveryPreparationScope): VmRecoveryPreparedHints {
    return {
      take: (kaId, options) => this.#take(scope, kaId, options),
    };
  }

  /**
   * The consumer is done with its prepared hints: whatever it did not take is
   * discarded (and any read still in flight is cancelled), freeing the single
   * batch slot for the next preparation.
   */
  release(scope: VmRecoveryPreparationScope): void {
    const batch = this.#batch;
    if (!batch || batch.released) return;
    if (!this.#sameOperation(batch.scope, scope)) return;
    this.#dropBatch(batch, true);
  }

  /**
   * Drop the prepared batch (generation change, unsubscribe, binding change,
   * shutdown). With a `localCgId` only that graph's batch is dropped.
   */
  discard(localCgId?: string): void {
    const batch = this.#batch;
    if (!batch || batch.released) return;
    if (localCgId !== undefined && batch.scope.localCgId !== localCgId) return;
    this.#dropBatch(batch, true);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Stop for good: cancel speculative reads, drop hints and wait for every
   * physical read this owner started to settle. Late results are never applied.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.discard();
    await Promise.allSettled(this.#physical);
  }

  stats(): VmRecoveryPreparationStats {
    return Object.freeze({
      ...this.#counters,
      retainedBytes: this.#retainedBytes,
      activeReads: this.#activeReads,
    });
  }

  /** An unconsumed batch whose operation ended, expired or lost ownership no longer holds the slot. */
  #batchIsDead(batch: PreparedBatch): boolean {
    return batch.scope.signal?.aborted === true
      || !this.#scopeIsCurrent(batch.scope)
      || this.#now() - batch.createdAt > this.#limits.maxHintAgeMs;
  }

  #sameOperation(left: VmRecoveryPreparationScope, right: VmRecoveryPreparationScope): boolean {
    return left.localCgId === right.localCgId
      && left.onChainCgId === right.onChainCgId
      && left.generation === right.generation;
  }

  #scopeIsCurrent(scope: VmRecoveryPreparationScope): boolean {
    try {
      return scope.isCurrent();
    } catch {
      return false;
    }
  }

  #dropBatch(batch: PreparedBatch, abortInflight: boolean): void {
    if (batch.released) return;
    batch.released = true;
    if (this.#batch === batch) this.#batch = undefined;
    batch.detachScopeSignal();
    for (const entry of batch.entries.values()) {
      if (entry.state !== 'taken') this.#counters.discardedUnused += 1;
      this.#retainedBytes = Math.max(0, this.#retainedBytes - entry.bytes);
      entry.bytes = 0;
      if (entry.state === 'ready' || entry.state === 'queued') entry.state = 'unusable';
    }
    if (abortInflight && !batch.controller.signal.aborted) {
      batch.controller.abort(new Error('VM recovery preparation discarded'));
    }
  }

  #pump(batch: PreparedBatch): void {
    while (
      !batch.released
      && !batch.controller.signal.aborted
      && this.#activeReads < this.#limits.maxSpeculativeReads
    ) {
      // Recovery ownership can end without the lifecycle signal aborting (a stale generation, a
      // rebind). A read started now would spend shared background capacity on a result that is
      // discarded, so a dead batch stops here; reads already issued stay tracked until they settle.
      if (this.#batchIsDead(batch)) {
        this.#dropBatch(batch, true);
        return;
      }
      const next = [...batch.entries.values()].find((entry) => entry.state === 'queued');
      if (!next) return;
      this.#startRead(batch, next);
    }
  }

  #startRead(batch: PreparedBatch, entry: PreparedEntry): void {
    const sizing = this.#sizing;
    if (sizing === null) return;
    entry.state = 'reading';
    this.#activeReads += 1;
    this.#counters.readsStarted += 1;
    this.#counters.maxActiveReads = Math.max(this.#counters.maxActiveReads, this.#activeReads);
    const finish = (footprint: VmRecoveryChainFootprint | undefined): void => {
      // A result for a batch that was released, closed or aborted is never applied.
      if (batch.released || batch.controller.signal.aborted || !this.#scopeIsCurrent(batch.scope)) {
        this.#counters.lateDropped += 1;
        if (entry.state === 'reading') entry.state = 'unusable';
        return;
      }
      if (footprint) {
        const bytes = entryBytes(entry.kaId, footprint);
        if (this.#retainedBytes - entry.bytes + bytes > this.#limits.maxRetainedBytes) {
          entry.state = 'unusable';
          this.#counters.readsUnusable += 1;
          return;
        }
        this.#retainedBytes += bytes - entry.bytes;
        entry.bytes = bytes;
        entry.footprint = footprint;
        entry.state = 'ready';
        this.#counters.readsReady += 1;
        this.#counters.maxRetainedBytes = Math.max(this.#counters.maxRetainedBytes, this.#retainedBytes);
      } else {
        entry.state = 'unusable';
        this.#counters.readsUnusable += 1;
      }
    };
    const issue = (readSignal: AbortSignal): Promise<Awaited<ReturnType<
      VmRecoveryFootprintSizingReader['readUpdateContext']>>> => {
      let read: ReturnType<VmRecoveryFootprintSizingReader['readUpdateContext']>;
      try {
        read = sizing.readUpdateContext(BigInt(entry.kaId), { signal: readSignal });
      } catch (error) {
        read = Promise.reject(error);
      }
      // Capacity is released when the underlying request really settles, not
      // when the race below returns after an abort or a deadline.
      const settled: Promise<void> = Promise.resolve(read).then(() => undefined, () => undefined).finally(() => {
        this.#physical.delete(settled);
        this.#activeReads -= 1;
        // Freed capacity serves whichever batch is current now, not the (possibly
        // already released) batch that issued this read.
        const current = this.#batch;
        if (current && !current.released) this.#pump(current);
      });
      this.#physical.add(settled);
      return read;
    };
    entry.settled = (async (): Promise<void> => {
      let footprint: VmRecoveryChainFootprint | undefined;
      try {
        const context = await withOwnedRpcRequestContext(
          { requestClass: 'background', signal: batch.controller.signal },
          () => readVmRecoveryFootprintWithDeadline(
            issue,
            batch.controller.signal,
            this.#limits.readTimeoutMs,
          ),
        );
        if (context !== VM_RECOVERY_BRIDGE_ABORTED && context !== VM_RECOVERY_BRIDGE_TIMED_OUT) {
          footprint = vmRecoveryFootprintFromUpdateContext(context);
        }
      } catch {
        footprint = undefined;
      }
      finish(footprint);
    })();
  }

  async #take(
    scope: VmRecoveryPreparationScope,
    kaId: string,
    options: { readonly maxWaitMs: number; readonly signal?: AbortSignal },
  ): Promise<VmRecoveryChainFootprint | undefined> {
    const miss = (stale = false): undefined => {
      this.#counters.misses += 1;
      if (stale) this.#counters.staleMisses += 1;
      return undefined;
    };
    const batch = this.#batch;
    if (!batch || batch.released || this.#closed) return miss();
    if (!this.#sameOperation(batch.scope, scope)) return miss(true);
    if (
      scope.signal?.aborted
      || !this.#scopeIsCurrent(scope)
      || this.#now() - batch.createdAt > this.#limits.maxHintAgeMs
    ) return miss(true);
    const entry = batch.entries.get(kaId);
    if (!entry || entry.state === 'taken' || entry.state === 'unusable') return miss();
    if (entry.state === 'queued') {
      // The consumer reads this candidate live now; never start a duplicate read.
      entry.state = 'unusable';
      return miss();
    }
    if (entry.state === 'reading' && entry.settled) {
      await this.#settleWithin(entry.settled, options);
    }
    // Re-check everything after any wait: ownership may have changed meanwhile.
    if (batch.released || this.#closed || options.signal?.aborted || !this.#scopeIsCurrent(scope)) {
      return miss(true);
    }
    if (entry.state !== 'ready' || !entry.footprint) return miss();
    entry.state = 'taken';
    this.#retainedBytes = Math.max(0, this.#retainedBytes - entry.bytes);
    entry.bytes = 0;
    this.#counters.hits += 1;
    return entry.footprint;
  }

  /**
   * Wait for a speculative read to settle, never longer than the consumer's own bound. A
   * timeout, a cancellation or a failed read is a plain hint miss; none of them cancels the
   * physical read, which stays accounted for until it really settles.
   */
  async #settleWithin(
    settled: Promise<void>,
    options: { readonly maxWaitMs: number; readonly signal?: AbortSignal },
  ): Promise<void> {
    if (options.signal?.aborted || options.maxWaitMs <= 0) return;
    try {
      await runBoundedOperation(() => settled, {
        label: 'VM recovery prepared sizing hint',
        timeoutMs: options.maxWaitMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch { /* a miss, not an error */ }
  }
}

/**
 * Resolve after `ms`, or sooner when `signal` aborts. Never rejects and leaves neither
 * a timer nor a listener behind, so a cancelled pass is not held by its own wait.
 */
export function vmRecoveryRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let onAbort: (() => void) | undefined;
    const timer = setTimeout(() => {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

const hostOwners = new WeakMap<object, VmRecoveryPreparation>();

/** The host's preparation owner, created on first use and replaced after a close. */
export function vmRecoveryPreparationFor(
  host: object,
  sizing: VmRecoveryFootprintSizingReader | null,
  limits: Partial<VmRecoveryPreparationLimits> = {},
  now?: () => number,
): VmRecoveryPreparation {
  const existing = hostOwners.get(host);
  if (existing && !existing.closed) return existing;
  const created = new VmRecoveryPreparation(sizing, limits, now);
  hostOwners.set(host, created);
  return created;
}

/** The host's owner if one was ever created; never creates one. */
export function existingVmRecoveryPreparation(host: object): VmRecoveryPreparation | undefined {
  const existing = hostOwners.get(host);
  return existing && !existing.closed ? existing : undefined;
}

/** Cumulative preparation counters as one logfmt-style fragment (secret-free). */
export function formatVmRecoveryPreparationStats(stats: VmRecoveryPreparationStats): string {
  return `prepAccepted=${stats.accepted} prepRefused=${stats.refused} prepReads=${stats.readsStarted} `
    + `prepReady=${stats.readsReady} prepUnusable=${stats.readsUnusable} prepHits=${stats.hits} `
    + `prepMisses=${stats.misses} prepStale=${stats.staleMisses} prepDiscarded=${stats.discardedUnused} `
    + `prepLate=${stats.lateDropped} prepMaxActive=${stats.maxActiveReads} `
    + `prepMaxBytes=${stats.maxRetainedBytes}`;
}
