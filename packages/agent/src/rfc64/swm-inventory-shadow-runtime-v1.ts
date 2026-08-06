export const RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1 = 16;

export type Rfc64SwmAuthorInventoryShadowMutationResultV1 = Readonly<{
  status: 'dormant' | 'applied' | 'existing' | 'absent' | 'failed';
  action: 'upsert' | 'remove';
  attempts: number;
  headObjectDigest: string | null;
  error: string | null;
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
  readonly #vmConfirmedVersions = new Map<string, Set<string>>();

  schedule(assetKey: string, observer: () => Promise<void>): boolean {
    if (this.#inFlight.size >= RFC64_SWM_INVENTORY_MAX_IN_FLIGHT_OBSERVERS_V1) {
      return false;
    }
    this.enqueue(assetKey, observer);
    return true;
  }

  runExclusive(assetKey: string, observer: () => Promise<void>): Promise<void> {
    return this.enqueue(assetKey, observer);
  }

  markVmConfirmed(assetKey: string, assertionVersion: string): void {
    let versions = this.#vmConfirmedVersions.get(assetKey);
    if (versions === undefined) {
      versions = new Set<string>();
      this.#vmConfirmedVersions.set(assetKey, versions);
    }
    versions.add(assertionVersion);
  }

  isVmConfirmed(assetKey: string, assertionVersion: string): boolean {
    return this.#vmConfirmedVersions.get(assetKey)?.has(assertionVersion) ?? false;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
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

  private enqueue(assetKey: string, observer: () => Promise<void>): Promise<void> {
    const predecessor = this.#assetTails.get(assetKey);
    let pending: Promise<void>;
    if (predecessor === undefined) {
      try {
        pending = observer();
      } catch (cause) {
        pending = Promise.reject(cause);
      }
    } else {
      pending = predecessor.catch(() => undefined).then(observer);
    }
    let tracked!: Promise<void>;
    tracked = pending.finally(() => {
      this.#inFlight.delete(tracked);
      if (this.#assetTails.get(assetKey) === tracked) {
        this.#assetTails.delete(assetKey);
        this.#vmConfirmedVersions.delete(assetKey);
      }
    });
    this.#assetTails.set(assetKey, tracked);
    this.#inFlight.add(tracked);
    void tracked.catch(() => undefined);
    return tracked;
  }
}
