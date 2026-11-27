import { observeStoreMutations } from './internal/observed-store-mutation.js';

/** Outstanding writes outlive a failed pass or barrier. A flush covers only
 * the generation captured before it started; concurrent later writes stay dirty. */
class ReconcileDurability {
  private written = 0;
  private persisted = 0;

  async observe<T>(work: () => Promise<T>): Promise<T> {
    return (await observeStoreMutations(work, () => { this.written += 1; })).result;
  }

  async flush(beforeWatermark: boolean, barrier: () => Promise<void>): Promise<void> {
    const through = this.written;
    if (!beforeWatermark && through === this.persisted) return;
    await barrier();
    this.persisted = Math.max(this.persisted, through);
  }
}

// One store-wide barrier can cover writes from any graph, but never writes
// observed after that barrier began. Weak ownership follows the agent/store.
const owners = new WeakMap<object, ReconcileDurability>();
export function vmReconcileDurability(owner: object): ReconcileDurability {
  let durability = owners.get(owner);
  if (!durability) { durability = new ReconcileDurability(); owners.set(owner, durability); }
  return durability;
}
