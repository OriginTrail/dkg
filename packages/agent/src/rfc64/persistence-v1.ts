import { dirname } from 'node:path';

import {
  openInventoryV1,
  type Rfc64InventoryV1Foundation,
} from './inventory-v1/index.js';
import {
  openRfc64ControlObjectStoreV1,
  type Rfc64ControlObjectStoreV1,
} from './control-object-store-v1.js';
import { createRfc64PersistenceOwnerCapabilityV1 } from './persistence-owner-capability-v1.js';

export interface OpenRfc64PersistenceOptionsV1 {
  /** Yield after each non-terminal fixed-size startup purge batch. */
  readonly yieldAfterPurgeBatch: () => Promise<void>;
}

/** One lifecycle owner for every RFC-64 resource protected by the inventory lease. */
export interface Rfc64PersistenceV1 {
  readonly inventory: Rfc64InventoryV1Foundation;
  readonly controlObjectStore: Rfc64ControlObjectStoreV1;
  readonly closed: boolean;
  /** Close the control store before releasing inventory ownership. */
  close(): void;
}

class OwnedRfc64PersistenceV1 implements Rfc64PersistenceV1 {
  #closed = false;

  constructor(
    readonly inventory: Rfc64InventoryV1Foundation,
    readonly controlObjectStore: Rfc64ControlObjectStoreV1,
  ) {}

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const failures: unknown[] = [];
    try {
      this.controlObjectStore.close();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      this.inventory.close();
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

  const inventory = await openInventoryV1(dataDir);
  try {
    for (;;) {
      const batch = inventory.purgeNextStartupStaleCandidateBatch();
      if (batch.done) break;
      await yieldAfterPurgeBatch();
    }
    const ownership = createRfc64PersistenceOwnerCapabilityV1(
      dirname(inventory.databasePath),
      () => !inventory.closed,
    );
    const controlObjectStore = await openRfc64ControlObjectStoreV1(ownership);
    return new OwnedRfc64PersistenceV1(inventory, controlObjectStore);
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
