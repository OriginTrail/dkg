// SPDX-License-Identifier: Apache-2.0
import type {
  DurableManifestDigest,
  DurableManifestPrefixDigest,
  SyncCheckpointEntry,
  SyncCheckpointStore,
} from './checkpoint/state.js';
import { deleteSyncPageCheckpoint } from './requester/page-fetch.js';

/**
 * A verified DATA prefix of one manifest generation, whichever peer served it.
 *
 * Durable checkpoints are keyed by the peer that served them, but what they
 * prove is local: every graph before the offset was verified against the
 * manifest and stored here.
 */
export interface VerifiedDurableBoundary {
  readonly manifestDigest: DurableManifestDigest;
  readonly manifestPrefixDigest: DurableManifestPrefixDigest;
  readonly offset: number;
  readonly terminal: boolean;
  /** When the checkpoint was last written, i.e. when this generation was last verified. */
  readonly updatedAtMs: number;
}

export function verifiedDurableBoundaryOf(
  entry: SyncCheckpointEntry | undefined,
): VerifiedDurableBoundary | undefined {
  if (!entry?.manifestDigest || !entry.manifestPrefixDigest || entry.offset <= 0) return undefined;
  return {
    manifestDigest: entry.manifestDigest,
    manifestPrefixDigest: entry.manifestPrefixDigest,
    offset: entry.offset,
    terminal: entry.terminal === true,
    updatedAtMs: entry.updatedAtMs,
  };
}

/**
 * The boundary worth continuing: within one generation the further one;
 * across generations the one verified last, since a graph's owner moves it
 * forward and an older generation's prefix rarely holds in a newer one.
 */
export function preferVerifiedDurableBoundary(
  current: VerifiedDurableBoundary | undefined,
  candidate: VerifiedDurableBoundary | undefined,
): VerifiedDurableBoundary | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  if (candidate.manifestDigest === current.manifestDigest) {
    return candidate.offset > current.offset ? candidate : current;
  }
  return candidate.updatedAtMs > current.updatedAtMs ? candidate : current;
}

/**
 * Give a peer the graph's verified boundary when its own checkpoint is behind
 * it, so its next DATA round continues there instead of at row 0.
 *
 * The boundary is written without a responder token. The round then primes a
 * fresh responder session and jumps to the boundary only if the peer's META
 * proves the same prefix (`resolveManifestCheckpointDecision`); otherwise it
 * starts at row 0 as before. A terminal boundary is never given: there is no
 * interrupted round to continue, and it would replace the peer's own offset.
 * Returns whether the checkpoint was replaced.
 */
export function seedVerifiedDurableBoundary(
  store: SyncCheckpointStore,
  checkpointKey: string,
  boundary: VerifiedDurableBoundary | undefined,
): boolean {
  if (!boundary || boundary.terminal) return false;
  const current = store.get(checkpointKey);
  if (current && current.offset >= boundary.offset) return false;
  deleteSyncPageCheckpoint(store, checkpointKey);
  store.setManifestBoundOffset(
    checkpointKey,
    boundary.offset,
    boundary.manifestDigest,
    undefined,
    boundary.manifestPrefixDigest,
  );
  return true;
}
