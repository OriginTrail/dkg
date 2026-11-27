// SPDX-License-Identifier: Apache-2.0

import type { SyncOnConnectPeerOutcome } from './sync-on-connect.js';

/**
 * The Context Graphs one ordinary sync-on-connect pass covers. `null` is the
 * peer's whole sync scope; a set names the only graphs the pass may sync.
 */
export type SyncOnConnectGraphScope = ReadonlySet<string> | null;

/** Whether a pass over `covering` already does all the work of `requested`. */
export function syncOnConnectGraphScopeCovers(
  covering: SyncOnConnectGraphScope,
  requested: SyncOnConnectGraphScope,
): boolean {
  if (covering === null) return true;
  if (requested === null) return false;
  for (const contextGraphId of requested) {
    if (!covering.has(contextGraphId)) return false;
  }
  return true;
}

/** The smallest scope covering both; `current` itself when it already covers `requested`. */
export function widenSyncOnConnectGraphScope(
  current: SyncOnConnectGraphScope,
  requested: SyncOnConnectGraphScope,
): SyncOnConnectGraphScope {
  if (syncOnConnectGraphScopeCovers(current, requested)) return current;
  if (current === null || requested === null) return null;
  return new Set([...current, ...requested]);
}

/**
 * A graph-scoped pass says nothing about the peer's other graphs, so it must
 * not stamp the peer fresh or record peer-level progress: either would hold
 * off the next whole-scope pass. Its retry and backoff verdict still counts.
 */
export function graphScopedSyncOnConnectPeerOutcome(
  outcome: SyncOnConnectPeerOutcome,
): SyncOnConnectPeerOutcome {
  return { ...outcome, fresh: false, progress: false };
}

/**
 * Coalesce the graphs whose accepted authority changed within one quiet
 * window into a single catch-up. Each new graph restarts the window, as the
 * peer-wide catch-up did before it was scoped.
 */
export class AuthorityAcceptedCatchupBatch {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private contextGraphIds = new Set<string>();

  constructor(
    private readonly delayMs: number,
    private readonly run: (contextGraphIds: ReadonlySet<string>) => void,
  ) {}

  add(contextGraphId: string): void {
    this.contextGraphIds.add(contextGraphId);
    if (this.timer !== null) clearTimeout(this.timer);
    const timer = setTimeout(() => {
      if (this.timer !== timer) return;
      this.timer = null;
      const contextGraphIds = this.contextGraphIds;
      this.contextGraphIds = new Set();
      this.run(contextGraphIds);
    }, this.delayMs);
    (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    this.timer = timer;
  }
}
