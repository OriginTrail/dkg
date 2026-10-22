// SPDX-License-Identifier: Apache-2.0

/**
 * Process-local tombstone generations, one counter per chain-event-log scope.
 *
 * A tombstone exists to REPAIR the log: it drops every row, and the scope is
 * then re-initialized from the chain. The re-initialized log keeps the same
 * lineage when the chain is the same one, and its revision is just another
 * step of the same CAS token, so nothing in the store state says that the rows
 * a reader folded earlier were thrown away in between. A reader that keeps
 * state derived from the rows across revisions (the knowledge-asset ordinal
 * cache) reads this counter instead, and never carries anything built under
 * an older generation past it.
 *
 * WHY PROCESS-LOCAL IS ENOUGH
 * - The one writer of a scope is the chain-index tick, and the tick is the one
 *   caller of `store.tombstone` (`chain-index-tick.ts`, through
 *   {@link tombstoneChainEventLogScope}). The node builds exactly one tick per
 *   scope, in `evm-chain-index-runtime.ts`, and builds the knowledge-asset read
 *   model in the same closure over the same store, so both import this module
 *   through the same module instance.
 * - Nothing crosses a process or thread boundary with the read model: the
 *   per-wallet publisher adapters borrow the owner's binding through a
 *   late-bound in-process getter, never a store, so they read the SAME cache
 *   this counter guards. A worker that built a read model of its own would
 *   need a store of its own, which the composition root never hands out.
 * - A tombstone from an earlier process, or from any process other than this
 *   one, happened before this process built anything: the caches this counter
 *   guards are in memory and start empty on every restart.
 */

import type { ChainEventLogStore } from './chain-event-log.js';

const generations = new Map<string, number>();

/**
 * How many tombstones this process has issued (or may have issued) on `scope`.
 *
 * Only ever grows. A reader records it BEFORE it loads the state it folds, and
 * compares it again AFTER loading the state it wants to extend from: a value
 * that moved in between is a log that may have been rebuilt underneath it.
 */
export function chainEventLogTombstoneGeneration(scope: string): number {
  return generations.get(scope) ?? 0;
}

/**
 * `store.tombstone(scope, expectedRevision)`, and the generation bump every
 * in-process reader relies on. Code in this package tombstones a scope through
 * this function and never through the store directly.
 *
 * The bump comes AFTER the store call, never before it. A reader that saw the
 * new generation must never go on to fold rows from before the tombstone: with
 * the bump after the commit, any state that reader loads is already the
 * tombstoned (unreadable) scope or its re-initialization. Bumping first would
 * let a fold that loaded pre-tombstone rows stamp them with the new generation.
 *
 * Every outcome except a clean CAS loss (`undefined`: the scope was not at
 * `expectedRevision` and nothing was dropped) bumps, including a store that
 * throws, because a throw does not say that nothing was dropped and a spurious
 * bump costs a reader one full re-fold.
 */
export async function tombstoneChainEventLogScope(
  store: Pick<ChainEventLogStore, 'tombstone'>,
  scope: string,
  expectedRevision: number,
): Promise<number | undefined> {
  let dropped = true;
  try {
    const revision = await store.tombstone(scope, expectedRevision);
    dropped = revision !== undefined;
    return revision;
  } finally {
    if (dropped) generations.set(scope, chainEventLogTombstoneGeneration(scope) + 1);
  }
}
