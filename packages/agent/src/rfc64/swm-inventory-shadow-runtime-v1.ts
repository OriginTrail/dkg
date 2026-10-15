import { AsyncResource } from 'node:async_hooks';

import { Rfc64SerializedScopeRuntimeV1 } from './serialized-scope-runtime-v1.js';

// A freshly-created private CG can durably accept its first shares before the
// membership-derived default responsibility and accepted authority converge.
// Keep the detached observer alive across that bounded lifecycle gap so an
// otherwise successful share cannot be omitted from the authoritative head.
const RFC64_DEFAULT_RESPONSIBILITY_SETTLE_RETRY_DELAYS_MS_V1 = Object.freeze([
  0,
  100,
  250,
  500,
  1_000,
  2_000,
  4_000,
  8_000,
] as const);


export const RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1 = 16;

/** GH#3134 — one author's lane of SWM-inventory writes: one graph lane, one author. */
export interface Rfc64SwmInventoryAuthorLaneV1 {
  readonly contextGraphId: string;
  readonly subGraphName?: string | null;
  readonly authorAddress: string;
}

/** GH#3134 — one asset's write to its author's SWM inventory. */
export interface Rfc64SwmInventoryWriteV1 extends Rfc64SwmInventoryAuthorLaneV1 {
  readonly assertionCoordinate: string;
}

/**
 * The key that one asset's work runs under, one piece after another: the observer of its share,
 * the removal at its confirmation, and its catalog placement.
 */
export function rfc64SwmInventoryAssetKeyV1(asset: Readonly<Rfc64SwmInventoryWriteV1>): string {
  return JSON.stringify([
    asset.contextGraphId,
    asset.subGraphName ?? null,
    asset.authorAddress.toLowerCase(),
    asset.assertionCoordinate,
  ]);
}

function inventoryLaneKeyV1(lane: Readonly<Rfc64SwmInventoryAuthorLaneV1>): string {
  return JSON.stringify([lane.contextGraphId, lane.subGraphName ?? null, lane.authorAddress.toLowerCase()]);
}
export const RFC64_SWM_INVENTORY_MAX_CONFIRMED_TOMBSTONES_V1 = 4_096;

export type Rfc64SwmAuthorInventoryShadowMutationResultV1 = Readonly<{
  status: 'dormant' | 'applied' | 'existing' | 'absent' | 'failed';
  action: 'upsert' | 'remove';
  attempts: number;
  headObjectDigest: string | null;
  error: string | null;
  dormantReason?: 'inactive-lane' | 'authority-transition' | 'vm-confirmed' | 'policy-mismatch';
}>;

export interface Rfc64SwmAuthorInventoryShadowStatusV1 {
  readonly attemptedUpserts: number;
  readonly appliedUpserts: number;
  readonly existingUpserts: number;
  readonly attemptedRemovals: number;
  readonly appliedRemovals: number;
  readonly absentRemovals: number;
  readonly failed: number;
  readonly casRetries: number;
  readonly lastAction: 'upsert' | 'remove' | null;
  readonly lastContextGraphId: string | null;
  readonly lastKaUal: string | null;
  readonly lastHeadDigest: string | null;
  readonly lastError: string | null;
}

/** Feature-owned process-local state for detached SWM inventory shadow work. */
export class Rfc64SwmInventoryShadowRuntimeV1 {
  readonly #stats = {
    attemptedUpserts: 0,
    appliedUpserts: 0,
    existingUpserts: 0,
    attemptedRemovals: 0,
    appliedRemovals: 0,
    absentRemovals: 0,
    failed: 0,
    casRetries: 0,
    lastAction: null as 'upsert' | 'remove' | null,
    lastContextGraphId: null as string | null,
    lastKaUal: null as string | null,
    lastHeadDigest: null as string | null,
    lastError: null as string | null,
  };
  readonly #inFlight = new Set<Promise<unknown>>();
  readonly #assetTails = new Map<string, Promise<unknown>>();
  /** Per author key, the registered inventory writes still queued or running. */
  readonly #authorWork = new Map<string, Set<Promise<unknown>>>();
  readonly #scopeRuntime = new Rfc64SerializedScopeRuntimeV1(
    'RFC-64 SWM inventory scope operation aborted',
  );
  readonly #vmConfirmedTombstones = new Map<string, true>();
  readonly #pendingExecutions: Array<() => void> = [];
  #activeExecutions = 0;
  #closeAbort = new AbortController();
  #closed = false;

  /** Aborts lifecycle-only waits when shutdown fences detached observers. */
  get shutdownSignal(): AbortSignal {
    return this.#closeAbort.signal;
  }

  get responsibilitySettlementRetryDelaysMs(): readonly number[] {
    return RFC64_DEFAULT_RESPONSIBILITY_SETTLE_RETRY_DELAYS_MS_V1;
  }

  waitForResponsibilitySettlement(
    delayMs: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (delayMs === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      }, delayMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Work on one asset that writes no inventory row (a catalog placement), in turn with that asset's work. */
  schedule(assetKey: string, observer: () => Promise<void>): boolean {
    if (this.#closed) return false;
    this.enqueue(assetKey, observer, false);
    return true;
  }

  runExclusive<T>(assetKey: string, observer: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error('RFC-64 SWM inventory observer runtime is closed'));
    }
    return this.enqueue(assetKey, observer, true);
  }

  /**
   * GH#3134 — an inventory write: in turn with its asset's other work, and counted among its
   * author lane's writes until it ends.
   */
  scheduleInventoryWrite(write: Readonly<Rfc64SwmInventoryWriteV1>, observer: () => Promise<void>): boolean {
    if (this.#closed) return false;
    this.enqueue(rfc64SwmInventoryAssetKeyV1(write), observer, false, [], inventoryLaneKeyV1(write));
    return true;
  }

  runInventoryWriteExclusive<T>(write: Readonly<Rfc64SwmInventoryWriteV1>, observer: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error('RFC-64 SWM inventory observer runtime is closed'));
    }
    return this.enqueue(rfc64SwmInventoryAssetKeyV1(write), observer, true, [], inventoryLaneKeyV1(write));
  }

  /** GH#3134 — whether an inventory write of this author lane is queued or running. */
  hasInventoryWrites(lane: Readonly<Rfc64SwmInventoryAuthorLaneV1>): boolean {
    return (this.#authorWork.get(inventoryLaneKeyV1(lane))?.size ?? 0) > 0;
  }

  /**
   * GH#3134 — the removal of a finalized asset's row, itself an inventory write of the lane, to
   * start once the lane's writes queued so far have ended: what it reads includes their commits.
   */
  scheduleAfterInventoryWrites(
    lane: Readonly<Rfc64SwmInventoryAuthorLaneV1>,
    kaUal: string,
    observer: () => Promise<void>,
  ): boolean {
    if (this.#closed) return false;
    const laneKey = inventoryLaneKeyV1(lane);
    const queued = [...(this.#authorWork.get(laneKey) ?? [])];
    this.enqueue(JSON.stringify(['finalized-twin', laneKey, kaUal]), observer, false, queued, laneKey);
    return true;
  }

  /** Serialize inventory mutations and catalog reads for one author/scope. */
  runScopeExclusive<T>(
    scopeKey: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#scopeRuntime.run(scopeKey, operation, signal);
  }

  markVmConfirmed(
    assetKey: string,
    assertionVersion: string,
    shareOperationId: string,
  ): void {
    const tombstone = this.confirmedTombstoneKey(
      assetKey,
      assertionVersion,
      shareOperationId,
    );
    this.#vmConfirmedTombstones.delete(tombstone);
    this.#vmConfirmedTombstones.set(tombstone, true);
    while (
      this.#vmConfirmedTombstones.size
      > RFC64_SWM_INVENTORY_MAX_CONFIRMED_TOMBSTONES_V1
    ) {
      const oldest = this.#vmConfirmedTombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#vmConfirmedTombstones.delete(oldest);
    }
  }

  isVmConfirmed(
    assetKey: string,
    assertionVersion: string,
    shareOperationId: string,
  ): boolean {
    return this.#vmConfirmedTombstones.has(
      this.confirmedTombstoneKey(assetKey, assertionVersion, shareOperationId),
    );
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
  }

  /** Fence new observers, then drain every already-admitted asset mutation. */
  async closeAndDrain(): Promise<void> {
    this.#closed = true;
    this.#closeAbort.abort();
    await this.drain();
    await this.#scopeRuntime.closeAndDrain();
  }

  /** Reopen the fully drained feature owner for same-instance restart. */
  reopen(): void {
    if (this.#inFlight.size > 0 || this.#pendingExecutions.length > 0) {
      throw new Error('RFC-64 SWM inventory observer runtime cannot reopen before drain');
    }
    this.#closeAbort = new AbortController();
    this.#scopeRuntime.reopen();
    this.#closed = false;
  }

  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  status(): Readonly<Rfc64SwmAuthorInventoryShadowStatusV1> {
    return Object.freeze({ ...this.#stats });
  }

  record(
    result: Rfc64SwmAuthorInventoryShadowMutationResultV1,
    contextGraphId: string,
    kaUal: string | null,
  ): void {
    if (result.status === 'dormant') return;
    const stats = this.#stats;
    if (result.action === 'upsert') stats.attemptedUpserts += 1;
    else stats.attemptedRemovals += 1;
    stats.casRetries += Math.max(0, result.attempts - 1);
    if (result.status === 'applied') {
      if (result.action === 'upsert') stats.appliedUpserts += 1;
      else stats.appliedRemovals += 1;
    } else if (result.status === 'existing') {
      stats.existingUpserts += 1;
    } else if (result.status === 'absent') {
      stats.absentRemovals += 1;
    } else {
      stats.failed += 1;
    }
    stats.lastAction = result.action;
    stats.lastContextGraphId = contextGraphId;
    stats.lastKaUal = kaUal;
    if (result.status !== 'failed') stats.lastHeadDigest = result.headObjectDigest;
    stats.lastError = result.error;
  }

  private enqueue<T>(
    assetKey: string,
    observer: () => Promise<T>,
    priority: boolean,
    after: readonly Promise<unknown>[] = [],
    authorKey?: string,
  ): Promise<T> {
    const tail = this.#assetTails.get(assetKey);
    const predecessor = after.length === 0
      ? tail
      : Promise.all([...after, ...(tail === undefined ? [] : [tail])].map((work) => work.catch(() => undefined)));
    const pending = predecessor === undefined
      ? this.runBounded(observer, priority)
      : predecessor.catch(() => undefined).then(
        () => this.runBounded(observer, priority),
      );
    let authorWork: Set<Promise<unknown>> | undefined;
    if (authorKey !== undefined) {
      authorWork = this.#authorWork.get(authorKey) ?? new Set();
      this.#authorWork.set(authorKey, authorWork);
    }
    let tracked!: Promise<T>;
    tracked = pending.finally(() => {
      this.#inFlight.delete(tracked);
      if (this.#assetTails.get(assetKey) === tracked) {
        this.#assetTails.delete(assetKey);
      }
      authorWork?.delete(tracked);
      if (authorWork?.size === 0 && this.#authorWork.get(authorKey!) === authorWork) this.#authorWork.delete(authorKey!);
    });
    this.#assetTails.set(assetKey, tracked);
    this.#inFlight.add(tracked);
    authorWork?.add(tracked);
    void tracked.catch(() => undefined);
    return tracked;
  }

  private runBounded<T>(observer: () => Promise<T>, priority: boolean): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // A queued observer must retain its caller's store/RPC context, not inherit the releaser's.
      const start = AsyncResource.bind((): void => {
        this.#activeExecutions += 1;
        let execution: Promise<T>;
        try {
          execution = observer();
        } catch (cause) {
          execution = Promise.reject(cause);
        }
        const finish = (): void => {
          this.#activeExecutions -= 1;
          queueMicrotask(() => this.pump());
        };
        void execution.then(
          (result) => {
            resolve(result);
            finish();
          },
          (cause) => {
            reject(cause);
            finish();
          },
        );
      });
      if (priority) this.#pendingExecutions.unshift(start);
      else this.#pendingExecutions.push(start);
      this.pump();
    });
  }

  private pump(): void {
    while (
      this.#activeExecutions < RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1
      && this.#pendingExecutions.length > 0
    ) {
      this.#pendingExecutions.shift()!();
    }
  }

  private confirmedTombstoneKey(
    assetKey: string,
    assertionVersion: string,
    shareOperationId: string,
  ): string {
    return `${assetKey}\n${assertionVersion}\n${shareOperationId}`;
  }
}

const RUNTIMES_V1 = new WeakMap<object, Rfc64SwmInventoryShadowRuntimeV1>();

/** One feature-owned inventory/projection runtime per agent instance. */
export function rfc64SwmInventoryShadowRuntimeV1(
  owner: object,
): Rfc64SwmInventoryShadowRuntimeV1 {
  let runtime = RUNTIMES_V1.get(owner);
  if (runtime === undefined) {
    runtime = new Rfc64SwmInventoryShadowRuntimeV1();
    RUNTIMES_V1.set(owner, runtime);
  }
  return runtime;
}
