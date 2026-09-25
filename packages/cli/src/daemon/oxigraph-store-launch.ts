/**
 * How the managed Oxigraph server launches against its store. The server
 * launches Oxigraph with `oxigraphStoreArgs` and hands each spawn to its
 * `OxigraphStoreOwnership`, which orders everything the store needs around
 * it. The orphan reclaim (`oxigraph-orphan.ts`) recognises a lock holder by
 * the same arguments, so the two cannot drift apart.
 */
import type { ChildProcess } from 'node:child_process';

/** The leading `oxigraph` arguments that open `location`. */
export function oxigraphStoreArgs(location: string): string[] {
  return ['serve', '--location', location];
}

/**
 * The store side of every managed Oxigraph launch, boot and restart alike:
 * reclaim the store, spawn, and record who owns it. The server builds one
 * (`createOxigraphStoreOwnership`) for each start, and its `stop()` closes it.
 *
 * The server treats a rejection as a failed launch: at boot it stops the
 * child and rethrows; on a supervised restart it stops the child and retries
 * with backoff. An implementation therefore handles its expected failures
 * itself (the production owner record logs and resolves) and rejects only
 * for defects.
 */
export interface OxigraphStoreOwnership {
  /**
   * Stop orphaned Oxigraph processes that hold the store lock, then run
   * `spawn` and record its child as the store's owner. Resolves to null
   * without spawning once `close()` has been called. `spawn` hands the child
   * to the server before this resolves, so the server can stop it if a later
   * step rejects.
   */
  launch(spawn: () => ChildProcess): Promise<OxigraphStoreLaunch | null>;
  /**
   * Refuse further launches and records. Resolves once no owner-record write
   * is in flight, so the store directory is quiet afterwards.
   */
  close(): Promise<void>;
}

/** One launch that `OxigraphStoreOwnership.launch` spawned and recorded. */
export interface OxigraphStoreLaunch {
  readonly child: ChildProcess;
  /** Record `oxigraphPid`, the launch's verified listener, as the store's Oxigraph. */
  ready(oxigraphPid: number): Promise<void>;
}
