/**
 * The contract between the managed Oxigraph server and whoever owns its
 * store. The server launches Oxigraph with `oxigraphStoreArgs` and calls the
 * `OxigraphStoreOwnership` steps around each launch. The orphan reclaim
 * (`oxigraph-orphan.ts`) implements those steps and recognises a lock holder
 * by the same arguments, so the two cannot drift apart.
 */

/** The leading `oxigraph` arguments that open `location`. */
export function oxigraphStoreArgs(location: string): string[] {
  return ['serve', '--location', location];
}

/**
 * The store-ownership steps of each managed Oxigraph launch, called in order.
 * Built where the binary catalog is known (the managed layer).
 *
 * The server awaits every step and treats a rejection as a failed launch: at
 * boot it stops the child and rethrows; on a supervised restart it stops the
 * child and retries with backoff. An implementation therefore handles its
 * expected failures itself (the production owner record logs and resolves)
 * and rejects only for defects.
 */
export interface OxigraphStoreOwnership {
  /** Stop orphaned Oxigraph processes that hold the store lock. */
  beforeSpawn(): Promise<void>;
  /** Record the new launch as the store's owner. */
  spawned(launch: { launcherPid: number }): Promise<void>;
  /** Add the verified Oxigraph to the owner record. */
  ready(launch: { launcherPid: number; oxigraphPid: number }): Promise<void>;
}
