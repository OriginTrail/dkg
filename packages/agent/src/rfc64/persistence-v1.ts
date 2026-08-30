import {
  createRfc64InventoryOperationsViewV1,
  createRfc64SwmAuthorInventoryOperationsViewV1,
  openInventoryV1,
  type Rfc64InventoryV1Foundation,
  type Rfc64InventoryV1OperationsV1,
  type Rfc64SwmAuthorInventoryOperationsV1,
} from './inventory-v1/index.js';
import {
  type Rfc64ControlObjectOperationsV1,
  type Rfc64ControlObjectStoreV1,
} from './control-object-store-v1.js';
import { openRfc64ControlObjectStoreForOwnedPersistenceRootV1 } from './control-object-store-v1-internal.js';
import {
  type Rfc64KaBundleOperationsV1,
  type Rfc64KaBundleStoreV1,
} from './ka-bundle-store-v1.js';
import { openRfc64KaBundleStoreForOwnedPersistenceRootV1 } from './ka-bundle-store-v1-internal.js';
import { resolveRfc64PersistenceRootV1 } from './persistence-layout-v1.js';
import { getRfc64PersistenceRootOwnershipForInventoryV1 } from './persistence-root-ownership-v1-internal.js';
import {
  openRfc64FinalizedPrivatePlacementRepairStoreV1,
  type Rfc64FinalizedPrivatePlacementRepairV1,
  type Rfc64FinalizedPrivatePlacementRepairStoreV1,
} from './finalized-private-placement-repair-store-v1.js';

export interface OpenRfc64PersistenceOptionsV1 {
  /** Yield after each non-terminal fixed-size startup purge batch. */
  readonly yieldAfterPurgeBatch: () => Promise<void>;
}

/** One lifecycle owner for every RFC-64 resource protected by the inventory lease. */
export interface Rfc64PersistenceV1 {
  readonly rootPath: string;
  /** Non-owning inventory operations; lifecycle methods remain private to this owner. */
  readonly inventory: Rfc64InventoryV1OperationsV1;
  /** Feature-owned SWM-only live-set persistence capability. */
  readonly swmAuthorInventory: Rfc64SwmAuthorInventoryOperationsV1;
  /** Durable post-confirmation work that must survive catalog delivery failures. */
  readonly finalizedPrivatePlacementRepairs: Rfc64FinalizedPrivatePlacementRepairStoreV1;
  /** Non-owning cache operations; lifecycle methods remain private to this owner. */
  readonly controlObjects: Rfc64ControlObjectOperationsV1;
  /** Durable content-addressed opaque KA bundles served by the native catalog transport. */
  readonly kaBundles: Rfc64KaBundleOperationsV1;
  readonly closed: boolean;
  /** Drain every durable content store before releasing inventory ownership. */
  close(): Promise<void>;
}

class OwnedRfc64PersistenceV1 implements Rfc64PersistenceV1 {
  #closed = false;
  #closePromise: Promise<void> | null = null;
  readonly #ownedInventory: Rfc64InventoryV1Foundation;
  readonly #ownedControlObjectStore: Rfc64ControlObjectStoreV1;
  readonly #ownedKaBundleStore: Rfc64KaBundleStoreV1;
  readonly inventory: Rfc64InventoryV1OperationsV1;
  readonly swmAuthorInventory: Rfc64SwmAuthorInventoryOperationsV1;
  readonly finalizedPrivatePlacementRepairs: Rfc64FinalizedPrivatePlacementRepairStoreV1;
  readonly controlObjects: Rfc64ControlObjectOperationsV1;
  readonly kaBundles: Rfc64KaBundleOperationsV1;

  constructor(
    readonly rootPath: string,
    ownedInventory: Rfc64InventoryV1Foundation,
    ownedControlObjectStore: Rfc64ControlObjectStoreV1,
    ownedKaBundleStore: Rfc64KaBundleStoreV1,
    finalizedPrivatePlacementRepairs: Rfc64FinalizedPrivatePlacementRepairStoreV1,
  ) {
    this.#ownedInventory = ownedInventory;
    this.#ownedControlObjectStore = ownedControlObjectStore;
    this.#ownedKaBundleStore = ownedKaBundleStore;
    this.inventory = createRfc64InventoryOperationsViewV1(
      ownedInventory,
      () => this.requireOpen(),
    );
    this.swmAuthorInventory = createRfc64SwmAuthorInventoryOperationsViewV1(
      ownedInventory,
      () => this.requireOpen(),
    );
    this.finalizedPrivatePlacementRepairs = Object.freeze({
      list: () => {
        this.requireOpen();
        return finalizedPrivatePlacementRepairs.list();
      },
      put: async (repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) => {
        this.requireOpen();
        await finalizedPrivatePlacementRepairs.put(repair);
        this.requireOpen();
      },
      delete: async (repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) => {
        this.requireOpen();
        await finalizedPrivatePlacementRepairs.delete(repair);
        this.requireOpen();
      },
    });
    this.controlObjects = createControlObjectOperationsView(ownedControlObjectStore);
    this.kaBundles = createKaBundleOperationsView(ownedKaBundleStore);
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.closeOwnedResources();
    return this.#closePromise;
  }

  private async closeOwnedResources(): Promise<void> {
    const failures: unknown[] = [];
    const cacheClosures = await Promise.allSettled([
      this.#ownedControlObjectStore.close(),
      this.#ownedKaBundleStore.close(),
    ]);
    for (const outcome of cacheClosures) {
      if (outcome.status === 'rejected') failures.push(outcome.reason);
    }
    try {
      this.#ownedInventory.close();
    } catch (cause) {
      failures.push(cause);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'RFC-64 persistence resources failed to close');
    }
  }

  private requireOpen(): void {
    if (this.#closed) throw new Error('RFC-64 persistence owner is closed');
  }
}

function createControlObjectOperationsView(
  controlObjectStore: Rfc64ControlObjectStoreV1,
): Rfc64ControlObjectOperationsV1 {
  return Object.freeze({
    namespaceDurability: controlObjectStore.namespaceDurability,
    stageVerifiedObjects:
      controlObjectStore.stageVerifiedObjects.bind(controlObjectStore),
    getVerifiedObject: controlObjectStore.getVerifiedObject.bind(controlObjectStore),
    getVerifiedObjectByDigest:
      controlObjectStore.getVerifiedObjectByDigest.bind(controlObjectStore),
  });
}

function createKaBundleOperationsView(
  kaBundleStore: Rfc64KaBundleStoreV1,
): Rfc64KaBundleOperationsV1 {
  return Object.freeze({
    namespaceDurability: kaBundleStore.namespaceDurability,
    putKaBundle: kaBundleStore.putKaBundle.bind(kaBundleStore),
    readKaBundleByDigest: kaBundleStore.readKaBundleByDigest.bind(kaBundleStore),
  });
}

/**
 * Acquire the inventory lease, finish bounded stale-candidate cleanup, then
 * open the immutable control-object and KA-bundle caches under that ownership boundary.
 */
export async function openRfc64PersistenceV1(
  dataDir: string,
  options: OpenRfc64PersistenceOptionsV1,
): Promise<Rfc64PersistenceV1> {
  const yieldAfterPurgeBatch = options?.yieldAfterPurgeBatch;
  if (typeof yieldAfterPurgeBatch !== 'function') {
    throw new TypeError('yieldAfterPurgeBatch must be a function');
  }

  const rootPath = resolveRfc64PersistenceRootV1(dataDir);
  const inventory = await openInventoryV1(dataDir);
  let controlObjectStore: Rfc64ControlObjectStoreV1 | undefined;
  let kaBundleStore: Rfc64KaBundleStoreV1 | undefined;
  try {
    for (;;) {
      const batch = inventory.purgeNextStartupStaleCandidateBatch();
      if (batch.done) break;
      await yieldAfterPurgeBatch();
    }
    const ownership = getRfc64PersistenceRootOwnershipForInventoryV1(inventory);
    controlObjectStore = await openRfc64ControlObjectStoreForOwnedPersistenceRootV1(ownership);
    kaBundleStore = await openRfc64KaBundleStoreForOwnedPersistenceRootV1(ownership);
    const finalizedPrivatePlacementRepairs =
      await openRfc64FinalizedPrivatePlacementRepairStoreV1(rootPath);
    return new OwnedRfc64PersistenceV1(
      rootPath,
      inventory,
      controlObjectStore,
      kaBundleStore,
      finalizedPrivatePlacementRepairs,
    );
  } catch (cause) {
    const failures: unknown[] = [cause];
    const cacheClosures = await Promise.allSettled([
      controlObjectStore?.close(),
      kaBundleStore?.close(),
    ].filter((operation): operation is Promise<void> => operation !== undefined));
    for (const outcome of cacheClosures) {
      if (outcome.status === 'rejected') failures.push(outcome.reason);
    }
    try {
      inventory.close();
    } catch (closeCause) {
      failures.push(closeCause);
    }
    if (failures.length === 1) throw cause;
    throw new AggregateError(
      failures,
      'RFC-64 persistence startup and owned-resource cleanup failed',
    );
  }
}
