import { dirname } from 'node:path';

import {
  openInventoryV1,
  type Rfc64InventoryV1Foundation,
} from './inventory-v1/index.js';
import {
  type Rfc64ControlObjectStoreV1,
} from './control-object-store-v1.js';
import { openRfc64ControlObjectStoreAtOwnedRootV1 } from './control-object-store-v1-internal.js';

export interface OpenRfc64PersistenceOptionsV1 {
  /** Yield after each non-terminal fixed-size startup purge batch. */
  readonly yieldAfterPurgeBatch: () => Promise<void>;
}

/** One lifecycle owner for every RFC-64 resource protected by the inventory lease. */
export interface Rfc64PersistenceV1 {
  readonly inventory: Rfc64InventoryV1Foundation;
  readonly controlObjectStore: Rfc64ControlObjectStoreV1;
  readonly closed: boolean;
  /** Drain the control store before releasing inventory ownership. */
  close(): Promise<void>;
}

class OwnedRfc64PersistenceV1 implements Rfc64PersistenceV1 {
  #closed = false;
  #closePromise: Promise<void> | null = null;

  constructor(
    readonly inventory: Rfc64InventoryV1Foundation,
    readonly controlObjectStore: Rfc64ControlObjectStoreV1,
  ) {}

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
      await this.controlObjectStore.close();
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
    const controlObjectStore = await openRfc64ControlObjectStoreAtOwnedRootV1(
      dirname(inventory.databasePath),
    );
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
