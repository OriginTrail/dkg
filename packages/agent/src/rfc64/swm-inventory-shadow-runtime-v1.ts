import { Rfc64SerializedScopeRuntimeV1 } from './serialized-scope-runtime-v1.js';

export const RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1 = 16;
export const RFC64_SWM_INVENTORY_MAX_CONFIRMED_TOMBSTONES_V1 = 4_096;

export type Rfc64SwmAuthorInventoryShadowMutationResultV1 = Readonly<{
  status: 'dormant' | 'applied' | 'existing' | 'absent' | 'failed';
  action: 'upsert' | 'remove';
  attempts: number;
  headObjectDigest: string | null;
  error: string | null;
  dormantReason?: 'inactive-lane' | 'vm-confirmed' | 'policy-mismatch';
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
  readonly #inFlight = new Set<Promise<void>>();
  readonly #assetTails = new Map<string, Promise<void>>();
  readonly #scopeRuntime = new Rfc64SerializedScopeRuntimeV1(
    'RFC-64 SWM inventory scope operation aborted',
  );
  readonly #vmConfirmedTombstones = new Map<string, true>();
  readonly #pendingExecutions: Array<() => void> = [];
  #activeExecutions = 0;
  #closed = false;

  schedule(assetKey: string, observer: () => Promise<void>): boolean {
    if (this.#closed) return false;
    this.enqueue(assetKey, observer, false);
    return true;
  }

  runExclusive(assetKey: string, observer: () => Promise<void>): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error('RFC-64 SWM inventory observer runtime is closed'));
    }
    return this.enqueue(assetKey, observer, true);
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
    await this.drain();
    await this.#scopeRuntime.closeAndDrain();
  }

  /** Reopen the fully drained feature owner for same-instance restart. */
  reopen(): void {
    if (this.#inFlight.size > 0 || this.#pendingExecutions.length > 0) {
      throw new Error('RFC-64 SWM inventory observer runtime cannot reopen before drain');
    }
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

  private enqueue(
    assetKey: string,
    observer: () => Promise<void>,
    priority: boolean,
  ): Promise<void> {
    const predecessor = this.#assetTails.get(assetKey);
    const pending = predecessor === undefined
      ? this.runBounded(observer, priority)
      : predecessor.catch(() => undefined).then(
        () => this.runBounded(observer, priority),
      );
    let tracked!: Promise<void>;
    tracked = pending.finally(() => {
      this.#inFlight.delete(tracked);
      if (this.#assetTails.get(assetKey) === tracked) {
        this.#assetTails.delete(assetKey);
      }
    });
    this.#assetTails.set(assetKey, tracked);
    this.#inFlight.add(tracked);
    void tracked.catch(() => undefined);
    return tracked;
  }

  private runBounded(observer: () => Promise<void>, priority: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const start = (): void => {
        this.#activeExecutions += 1;
        let execution: Promise<void>;
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
          () => {
            resolve();
            finish();
          },
          (cause) => {
            reject(cause);
            finish();
          },
        );
      };
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
