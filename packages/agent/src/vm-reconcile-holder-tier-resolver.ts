// SPDX-License-Identifier: Apache-2.0

/**
 * The holder tier's shared resolver: one per node, so the chain and phonebook
 * reads are amortized across every graph. It runs one read at a time under a
 * wall-clock bound that holds when a dependency ignores its abort signal,
 * coalesces concurrent callers, caches an answer for its TTL (a shorter one for a
 * failure or a resolution cut short), and lets only a read that nothing has
 * overtaken (no invalidation or reset since it started) move the walk.
 */

import {
  VM_HOLDER_TIER_FAILURE_RETRY_MS,
  VM_HOLDER_TIER_READ_BUDGET_SHARE,
  VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS,
  VM_HOLDER_TIER_RESOLUTION_TTL_MS,
  type VmHolderHintDeps,
  type VmHolderHintResolution,
  type VmHolderIdentityCache,
} from './vm-reconcile-holder-tier-types.js';
import {
  VM_HOLDER_TIER_FRESH_SCAN,
  type VmHolderScanState,
} from './vm-reconcile-holder-tier-carry.js';
import { resolveHolderScanWindow } from './vm-reconcile-holder-tier-walk.js';

export interface VmHolderHintResolverOptions {
  readonly resolutionTtlMs?: number;
  readonly failureRetryMs?: number;
  readonly resolutionTimeoutMs?: number;
}

/**
 * Run `work` and settle within `timeoutMs` no matter what it does. `work` gets
 * a signal that aborts at the deadline so cooperative dependencies stop early,
 * but the bound does not rely on them: the chain adapter's RPC calls take no
 * signal, and a stalled one would otherwise leave the caller waiting forever.
 *
 * Only the deadline is reported as `deadline`. A rejection of `work` before it
 * (an abort the caller wired in, or a defect) propagates. The abandoned
 * promise stays observed, so it cannot become an unhandled rejection when it
 * settles later, and nothing it does afterwards reaches the caller.
 */
export async function runWithinDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<{ readonly kind: 'settled'; readonly value: T } | { readonly kind: 'deadline' }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ readonly kind: 'deadline' }>((resolve) => {
    timer = setTimeout(() => {
      // Settle the race first: whatever the abort sets off in `work` queues
      // behind this, so the deadline is what the caller sees.
      resolve({ kind: 'deadline' });
      controller.abort(new Error(`Holder tier read exceeded its ${timeoutMs} ms deadline`));
    }, timeoutMs);
    // A pending deadline must never keep the process alive.
    (timer as { unref?: () => void }).unref?.();
  });
  const settled = (async () => ({ kind: 'settled' as const, value: await work(controller.signal) }))();
  settled.catch(() => undefined);
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A resolution that left rows unread or unexamined, whether a bound stopped it or
 * the tier was already satisfied: the next one continues the walk, so it is worth
 * running soon. (A satisfied tier keeps walking because what it carries behind a
 * flood of junk is verified only when the walk comes round again, and must be
 * before the carry expires.)
 */
export function cutShort(resolution: VmHolderHintResolution): boolean {
  if (resolution.kind !== 'resolved') return false;
  const { stopped, rowsLeft } = resolution.stats;
  return stopped === 'lookup-bound' || stopped === 'page-bound' || (stopped === 'satisfied' && rowsLeft);
}

/**
 * A shared read. It runs under one generation, or, while it waits behind an older
 * read, under none yet: it takes the generation current when it starts.
 */
interface InFlightRead {
  generation: number | undefined;
  /** {@link VmHolderHintResolver.reset} calls before it was queued: a reset after that cancels it. */
  readonly resets: number;
  readonly promise: Promise<VmHolderHintResolution>;
  /** Settles, never rejects, once the read has settled. */
  readonly settled: Promise<void>;
}

/**
 * Shared per node. Amortizes the chain and phonebook reads across every graph
 * (the resolution does not depend on the graph in the single-shard sharding
 * table), coalesces concurrent callers into one read and remembers a failure
 * briefly. Each graph copies the answer into its own state at its own recovery
 * pass, so a refresh here never changes another graph's roster mid-pass.
 *
 * At most one read runs at a time. A caller after {@link invalidate} never joins
 * a read that started before it, and does not start one beside it either: it
 * waits behind the older read (which ends within the resolution timeout) and
 * shares the one read that then starts, however many invalidations arrive
 * meanwhile. The chain therefore sees one read's lookups, not one per arrival.
 */
export class VmHolderHintResolver {
  readonly #deps: VmHolderHintDeps;
  readonly #identityCache: VmHolderIdentityCache = new Map();
  readonly #resolutionTtlMs: number;
  readonly #failureRetryMs: number;
  readonly #resolutionTimeoutMs: number;
  #cached: { readonly resolution: VmHolderHintResolution; readonly expiresAt: number } | undefined;
  /** The newest read: running, or queued behind an older one that is still running. */
  #inFlight: InFlightRead | undefined;
  #generation = 0;
  /** Bumped by {@link reset}: a read still queued behind an older one when it lands never starts. */
  #resets = 0;
  /**
   * The walk over the phonebook between resolutions. Only a read that started
   * after the latest {@link invalidate} or {@link reset} (the same
   * {@link #scanEpoch}) may move it: an older one may have read the phonebook
   * before what invalidated it.
   */
  #scan: VmHolderScanState = VM_HOLDER_TIER_FRESH_SCAN;
  #scanEpoch = 0;

  constructor(deps: VmHolderHintDeps, options: VmHolderHintResolverOptions = {}) {
    this.#deps = deps;
    this.#resolutionTtlMs = options.resolutionTtlMs ?? VM_HOLDER_TIER_RESOLUTION_TTL_MS;
    this.#failureRetryMs = options.failureRetryMs ?? VM_HOLDER_TIER_FAILURE_RETRY_MS;
    this.#resolutionTimeoutMs = options.resolutionTimeoutMs ?? VM_HOLDER_TIER_RESOLUTION_TIMEOUT_MS;
  }

  /**
   * Bumped by every {@link invalidate}. A caller that keeps what it learned
   * compares it before and after `resolve` to notice an invalidation that
   * landed mid-read: the answer it holds may predate what invalidated it.
   */
  get generation(): number {
    return this.#generation;
  }

  /**
   * The current resolution: cached while fresh, otherwise one shared read that
   * settles within the resolution timeout even when a dependency ignores its
   * abort signal. A caller after {@link invalidate} never joins a read that
   * started before it. Rejects only for this caller's own abort (which does
   * not cancel the shared read) or for a defect; an unavailable dependency is
   * an `unavailable` resolution, not a rejection.
   */
  async resolve(signal?: AbortSignal): Promise<VmHolderHintResolution> {
    const now = (this.#deps.now ?? Date.now)();
    const cached = this.#cached;
    if (cached !== undefined && now < cached.expiresAt) return cached.resolution;
    const newest = this.#inFlight;
    // A queued read has no generation yet and will start after every
    // invalidation so far, so it serves this caller, unless a reset has
    // cancelled it (then it will never read); a running one serves a caller only
    // if it started under the current generation.
    const serving = newest !== undefined
      && (newest.generation === undefined
        ? newest.resets === this.#resets
        : newest.generation === this.#generation);
    const inFlight = serving ? newest : this.#begin(newest);
    return waitFor(inFlight.promise, signal);
  }

  /**
   * Forget the cached answer, e.g. after the phonebook gained profiles. The walk
   * over the phonebook keeps its place, except that a read still running cannot
   * move it: what it read may predate the arrival, and the next read must
   * cover those rows again. (Invalidations arriving faster than a read ends
   * therefore hold the walk still; they come from phonebook fetches, which are
   * spaced by minutes.)
   *
   * The next read is fresh, but it resumes where the walk stands, so a profile
   * that arrives or changes in rows the walk has already passed is read only when
   * the walk wraps: up to one pass later (about 24 minutes with 3,000 junk wallets
   * at the default sweep), not at the next read.
   */
  invalidate(): void {
    this.#generation += 1;
    this.#scanEpoch += 1;
    this.#cached = undefined;
  }

  /**
   * Forget everything: the cached answer and the walk, which starts over from the
   * first row. A read still running is left to end within its deadline, but one
   * that is queued behind it never starts (no chain or phonebook read, nothing
   * remembered): its callers are told `reset`, and a caller after the reset gets
   * a read of its own behind the running one.
   */
  reset(): void {
    this.invalidate();
    this.#resets += 1;
    this.#scan = VM_HOLDER_TIER_FRESH_SCAN;
  }

  /**
   * Start a read for the current generation now, or, when `running` is an older
   * generation's read that has not ended, right after it has.
   */
  #begin(running: InFlightRead | undefined): InFlightRead {
    const read = {} as { -readonly [K in keyof InFlightRead]: InFlightRead[K] };
    read.generation = undefined;
    const resets = this.#resets;
    read.resets = resets;
    read.promise = (async (): Promise<VmHolderHintResolution> => {
      if (running !== undefined) await running.settled;
      // A reset (shutdown) that landed while this read waited cancels it: nothing
      // may be read or remembered on behalf of a resolver that was reset.
      if (resets !== this.#resets) return { kind: 'unavailable', reason: 'reset' };
      read.generation = this.#generation;
      return this.#read(read.generation);
    })();
    read.settled = read.promise.then(() => undefined, () => undefined);
    this.#inFlight = read;
    // Only the read that owns the slot frees it: an older read ending while a
    // newer one is queued or running must not clear the newer one.
    void read.settled.then(() => {
      if (this.#inFlight === read) this.#inFlight = undefined;
    });
    return read;
  }

  async #read(generation: number): Promise<VmHolderHintResolution> {
    const scan = this.#scan;
    const epoch = this.#scanEpoch;
    const outcome = await runWithinDeadline(
      (signal) => resolveHolderScanWindow(this.#deps, this.#identityCache, scan, signal, {
        readBudgetMs: Math.floor(this.#resolutionTimeoutMs * VM_HOLDER_TIER_READ_BUDGET_SHARE),
      }),
      this.#resolutionTimeoutMs,
    );
    let resolution: VmHolderHintResolution = { kind: 'unavailable', reason: 'timeout' };
    if (outcome.kind === 'settled') {
      resolution = outcome.value.resolution;
      // Only a read that finished in time moves the walk on, and only if no
      // invalidation or reset has landed since it started.
      if (epoch === this.#scanEpoch) this.#scan = outcome.value.next;
    }
    if (generation === this.#generation) {
      const now = (this.#deps.now ?? Date.now)();
      this.#cached = {
        resolution,
        expiresAt: now + (resolution.kind === 'resolved' && !cutShort(resolution)
          ? this.#resolutionTtlMs
          : this.#failureRetryMs),
      };
    }
    return resolution;
  }
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
