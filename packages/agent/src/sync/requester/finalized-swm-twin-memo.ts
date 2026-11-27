// SPDX-License-Identifier: Apache-2.0

/**
 * The shared-memory snapshots this node retired because their exact content is
 * finalized in its Verified Memory (`finalized-swm-twin-reconciliation.ts`).
 *
 * A public catch-up round materializes each snapshot it does not hold, and the
 * finalized-twin reconciliation retires the copy right after when Verified
 * Memory already holds the same bytes. The next round finds the copy gone, so
 * it fetches, writes and retires the snapshot again. On a graph of finalized
 * assets the round never completes its coverage, the catch-up repeats, and
 * every repeat redoes that work for every such asset on every peer.
 *
 * Remembering the retirement lets a later round count the snapshot as held and
 * write nothing, once the same proof passes again: Verified Memory still holds
 * that content, and no row of the shared-memory copy is left. The proof only
 * reads, unless a share brought the copy back, which it retires. The memo is
 * process-local, bounded and short-lived: a restart starts it empty, an entry
 * expires, and another version, digest or private commitment of the same asset
 * is another entry. It records only what the retirement proved: that the content
 * is finalized here. The rest of the twin's cleanup has a lifecycle of its own
 * (`owed-legacy-swm-retirements.ts`), and an entry is forgotten once its proof
 * fails or cannot run.
 */

import { BoundedLruCache } from '@origintrail-official/dkg-core';
import type { GraphScopedSwmRecoveryDescriptor } from '../graph-scoped-swm-recovery.js';

export const FINALIZED_SWM_TWIN_MEMO_TTL_MS = 6 * 60 * 60_000;
export const FINALIZED_SWM_TWIN_MEMO_MAX_ENTRIES = 20_000;

/** Every field the finalized-twin proof compares with Verified Memory, the private commitment included. */
type FinalizedSwmTwinIdentity = Pick<GraphScopedSwmRecoveryDescriptor,
  'subGraphName' | 'kaUal' | 'assertionVersion' | 'publicQuadsDigest' | 'publicQuadsCount'
  | 'privateTripleCount' | 'privateMerkleRoot'>;

function memoKey(contextGraphId: string, descriptor: FinalizedSwmTwinIdentity): string {
  return JSON.stringify([
    contextGraphId,
    descriptor.subGraphName ?? null,
    descriptor.kaUal,
    descriptor.assertionVersion,
    descriptor.publicQuadsDigest,
    descriptor.publicQuadsCount,
    descriptor.privateTripleCount,
    descriptor.privateMerkleRoot ?? null,
  ]);
}

export class FinalizedSwmTwinMemoV1 {
  /** Expiry time of each remembered retirement. */
  readonly #entries: BoundedLruCache<string, number>;
  readonly #ttlMs: number;
  readonly #now: () => number;

  constructor(options: { readonly maxEntries?: number; readonly ttlMs?: number; readonly now?: () => number } = {}) {
    this.#entries = new BoundedLruCache(options.maxEntries ?? FINALIZED_SWM_TWIN_MEMO_MAX_ENTRIES);
    this.#ttlMs = options.ttlMs ?? FINALIZED_SWM_TWIN_MEMO_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  /** The retirement of this exact snapshot proved its content finalized here. */
  remember(contextGraphId: string, descriptor: FinalizedSwmTwinIdentity): void {
    this.#entries.set(memoKey(contextGraphId, descriptor), this.#now() + this.#ttlMs);
  }

  /** Its proof failed or could not run: the round takes the snapshot the usual way. */
  forget(contextGraphId: string, descriptor: FinalizedSwmTwinIdentity): void {
    this.#entries.delete(memoKey(contextGraphId, descriptor));
  }

  /** Whether this exact snapshot was retired as finalized here, and the entry is still current. */
  retired(contextGraphId: string, descriptor: FinalizedSwmTwinIdentity): boolean {
    const key = memoKey(contextGraphId, descriptor);
    const expiresAt = this.#entries.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt > this.#now()) return true;
    this.#entries.delete(key);
    return false;
  }
}
