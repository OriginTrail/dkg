import {
  openInventoryV1,
  type Rfc64InventoryV1CandidateApi,
  type Rfc64InventoryV1Foundation,
} from './inventory-v1/index.js';
import {
  type Rfc64ControlObjectStoreV1,
} from './control-object-store-v1.js';
import { openRfc64ControlObjectStoreAtOwnedRootV1 } from './control-object-store-v1-internal.js';
import { resolveRfc64PersistenceRootV1 } from './persistence-layout-v1.js';

export interface OpenRfc64PersistenceOptionsV1 {
  /** Yield after each non-terminal fixed-size startup purge batch. */
  readonly yieldAfterPurgeBatch: () => Promise<void>;
}

/** One lifecycle owner for every RFC-64 resource protected by the inventory lease. */
export type Rfc64InventoryOperationsV1 = Omit<
  Rfc64InventoryV1CandidateApi,
  'purgeNextStartupStaleCandidateBatch'
>;

export type Rfc64ControlObjectOperationsV1 = Pick<
  Rfc64ControlObjectStoreV1,
  'namespaceDurability' | 'stageVerifiedObjects' | 'getVerifiedObject'
>;

export interface Rfc64PersistenceV1 {
  readonly rootPath: string;
  /** Non-owning inventory operations; lifecycle methods remain private to this owner. */
  readonly inventory: Rfc64InventoryOperationsV1;
  /** Non-owning cache operations; lifecycle methods remain private to this owner. */
  readonly controlObjects: Rfc64ControlObjectOperationsV1;
  readonly closed: boolean;
  /** Drain the control store before releasing inventory ownership. */
  close(): Promise<void>;
}

class OwnedRfc64PersistenceV1 implements Rfc64PersistenceV1 {
  #closed = false;
  #closePromise: Promise<void> | null = null;
  readonly #ownedInventory: Rfc64InventoryV1Foundation;
  readonly #ownedControlObjectStore: Rfc64ControlObjectStoreV1;
  readonly inventory: Rfc64InventoryOperationsV1;
  readonly controlObjects: Rfc64ControlObjectOperationsV1;

  constructor(
    readonly rootPath: string,
    ownedInventory: Rfc64InventoryV1Foundation,
    ownedControlObjectStore: Rfc64ControlObjectStoreV1,
  ) {
    this.#ownedInventory = ownedInventory;
    this.#ownedControlObjectStore = ownedControlObjectStore;
    this.inventory = createInventoryOperationsView(ownedInventory);
    this.controlObjects = createControlObjectOperationsView(ownedControlObjectStore);
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
    try {
      await this.#ownedControlObjectStore.close();
    } catch (cause) {
      failures.push(cause);
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
}

/**
 * Acquire the inventory lease, finish bounded stale-candidate cleanup, then
 * open the immutable control-object cache under that same ownership boundary.
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
  try {
    for (;;) {
      const batch = inventory.purgeNextStartupStaleCandidateBatch();
      if (batch.done) break;
      await yieldAfterPurgeBatch();
    }
    const controlObjectStore = await openRfc64ControlObjectStoreAtOwnedRootV1(
      rootPath,
    );
    return new OwnedRfc64PersistenceV1(rootPath, inventory, controlObjectStore);
  } catch (cause) {
    try {
      inventory.close();
    } catch (closeCause) {
      throw new AggregateError(
        [cause, closeCause],
        'RFC-64 persistence startup and inventory cleanup both failed',
      );
    }
    throw cause;
  }
}

function createInventoryOperationsView(
  inventory: Rfc64InventoryV1Foundation,
): Rfc64InventoryOperationsV1 {
  return Object.freeze({
    createCandidateSession: inventory.createCandidateSession.bind(inventory),
    putVerifiedCandidateBucket: inventory.putVerifiedCandidateBucket.bind(inventory),
    getCandidateBucket: inventory.getCandidateBucket.bind(inventory),
    beginCandidateBucketRows: inventory.beginCandidateBucketRows.bind(inventory),
    beginCandidateBucketDiff: inventory.beginCandidateBucketDiff.bind(inventory),
    pageCandidateBucketRows: inventory.pageCandidateBucketRows.bind(inventory),
    pageCandidateBucketAddedOrChanged:
      inventory.pageCandidateBucketAddedOrChanged.bind(inventory),
    pageCandidateBucketRemoved: inventory.pageCandidateBucketRemoved.bind(inventory),
    readVerifiedCandidateCatalogRow:
      inventory.readVerifiedCandidateCatalogRow.bind(inventory),
    verifyCandidateCatalogPrecommitV1:
      inventory.verifyCandidateCatalogPrecommitV1.bind(inventory),
    closeCandidateTraversal: inventory.closeCandidateTraversal.bind(inventory),
    discardCandidateSessionBatch: inventory.discardCandidateSessionBatch.bind(inventory),
    deleteCandidateBucket: inventory.deleteCandidateBucket.bind(inventory),
  });
}

function createControlObjectOperationsView(
  controlObjectStore: Rfc64ControlObjectStoreV1,
): Rfc64ControlObjectOperationsV1 {
  return Object.freeze({
    namespaceDurability: controlObjectStore.namespaceDurability,
    stageVerifiedObjects:
      controlObjectStore.stageVerifiedObjects.bind(controlObjectStore),
    getVerifiedObject: controlObjectStore.getVerifiedObject.bind(controlObjectStore),
  });
}
