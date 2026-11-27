/**
 * How the managed Oxigraph server launches against its store. The server
 * launches Oxigraph with `oxigraphStoreArgs` and hands each spawn to its
 * `OxigraphStoreOwnership`, which orders everything the store needs around
 * it. The orphan reclaim (`oxigraph-orphan.ts`) recognises a lock holder by
 * the same arguments, so the two cannot drift apart.
 */
import type { OxigraphLaunchHandle } from './oxigraph-launch-strategy.js';
import type { StoreHold } from './oxigraph-reclaim-policy.js';

/** The leading `oxigraph` arguments that open `location`. */
export function oxigraphStoreArgs(location: string): string[] {
  return ['serve', '--location', location];
}

/**
 * The store side of every managed Oxigraph launch, boot and restart alike:
 * reclaim the store, spawn, and record who owns it. The server builds one
 * (`createOxigraphStoreOwnership`) for each start, and its `stop()` closes it.
 *
 * Every expected result of a launch is an `OxigraphStoreLaunchOutcome`. A
 * rejection is a defect in one of its steps (the production owner record
 * logs its own write failures and resolves). The server fails that launch
 * like one that never became ready: at boot it stops the child and rethrows;
 * on a supervised restart it stops the child and retries with backoff.
 */
export interface OxigraphStoreOwnership {
  /**
   * Stop orphaned Oxigraph processes that hold the store lock, then run
   * `spawn` and record the launch it returns as the store's owner. Spawns
   * nothing once `close()` has been called, or when the reclaim leaves the
   * store possibly held by this node's Oxigraph (then the owner record is
   * left as it is, too). A launch that cannot be recorded is killed through
   * its handle before the launch rejects, so a spawned launch is either
   * handed back or stopped.
   */
  launch(spawn: () => OxigraphLaunchHandle): Promise<OxigraphStoreLaunchOutcome>;
  /**
   * Refuse further launches and records, and wait for a reclaim or owner
   * record in flight. If the last launch's wrapper had already exited when
   * `close()` was called (the watchdog killed on its own, while its
   * Oxigraph may still run), reclaim the store once more, by recorded
   * identity, unless the reclaim in flight found it free. Resolves once all
   * of that is done, so the store is quiet. Idempotent.
   */
  close(): Promise<void>;
}

/** What `OxigraphStoreOwnership.launch` did. */
export type OxigraphStoreLaunchOutcome =
  /** Spawned and recorded. */
  | { kind: 'launched'; launch: OxigraphStoreLaunch }
  /** Nothing spawned: `close()` was called first. */
  | { kind: 'closed' }
  /** Nothing spawned or recorded: the store may still be held by this node's Oxigraph. */
  | { kind: 'blocked'; hold: StoreHold };

/** One launch that `OxigraphStoreOwnership.launch` spawned and recorded. */
export interface OxigraphStoreLaunch {
  readonly oxigraph: OxigraphLaunchHandle;
  /** Record `oxigraphPid`, the launch's verified listener, as the store's Oxigraph. */
  ready(oxigraphPid: number): Promise<void>;
}
