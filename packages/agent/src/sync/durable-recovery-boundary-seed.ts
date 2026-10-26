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
 * record is local: every graph before the offset was verified against the
 * manifest and stored here. A boundary is worth no more than the checkpoint it
 * was read from: it is offered only while that checkpoint still records it,
 * and only for that checkpoint's lifetime.
 */
export interface VerifiedDurableBoundary {
  readonly manifestDigest: DurableManifestDigest;
  readonly manifestPrefixDigest: DurableManifestPrefixDigest;
  readonly offset: number;
  readonly terminal: boolean;
  /** When the checkpoint was last written, i.e. when this generation was last verified. */
  readonly updatedAtMs: number;
  /** The checkpoint the boundary was read from. */
  readonly sourceCheckpointKey: string;
}

export function verifiedDurableBoundaryOf(
  entry: SyncCheckpointEntry | undefined,
  sourceCheckpointKey: string,
): VerifiedDurableBoundary | undefined {
  if (!entry?.manifestDigest || !entry.manifestPrefixDigest || entry.offset <= 0) return undefined;
  return {
    manifestDigest: entry.manifestDigest,
    manifestPrefixDigest: entry.manifestPrefixDigest,
    offset: entry.offset,
    terminal: entry.terminal === true,
    updatedAtMs: entry.updatedAtMs,
    sourceCheckpointKey,
  };
}

/**
 * The checkpoint a boundary was read from, while it still records that
 * boundary: unexpired, of the same generation, prefix and offset. A deleted or
 * expired checkpoint, or one that moved, ends the boundary.
 */
export function liveDurableBoundarySource(
  store: SyncCheckpointStore,
  boundary: VerifiedDurableBoundary | undefined,
): SyncCheckpointEntry | undefined {
  if (!boundary) return undefined;
  const source = store.get(boundary.sourceCheckpointKey);
  return source
    && source.manifestDigest === boundary.manifestDigest
    && source.manifestPrefixDigest === boundary.manifestPrefixDigest
    && source.offset === boundary.offset
    ? source
    : undefined;
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

/** One boundary of one generation, as a peer's refusal of it is remembered. */
export function durableBoundaryIdentity(manifestDigest: string | undefined, offset: number): string {
  return `${manifestDigest ?? ''}\0${offset}`;
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
 * The written checkpoint keeps the source checkpoint's lifetime, and nothing
 * is written once that checkpoint no longer records the boundary. Returns
 * whether the checkpoint was replaced.
 */
export function seedVerifiedDurableBoundary(
  store: SyncCheckpointStore,
  checkpointKey: string,
  boundary: VerifiedDurableBoundary | undefined,
): boolean {
  if (!boundary || boundary.terminal) return false;
  const source = liveDurableBoundarySource(store, boundary);
  if (!source) return false;
  const current = store.get(checkpointKey);
  if (current && current.offset >= boundary.offset) return false;
  deleteSyncPageCheckpoint(store, checkpointKey);
  store.setManifestBoundOffset(
    checkpointKey,
    boundary.offset,
    boundary.manifestDigest,
    source.updatedAtMs,
    boundary.manifestPrefixDigest,
  );
  return true;
}

/** Cross-peer resume state for one graph, retained across recovery runs. */
export class DurableGraphResumePolicy {
  private boundary: VerifiedDurableBoundary | undefined;
  private readonly refusedByPeer = new Map<string, string>();

  private remember(store: SyncCheckpointStore, candidates: readonly {
    checkpointKey: string; checkpoint: SyncCheckpointEntry | undefined;
  }[]): void {
    this.boundary = candidates.reduce(
      (current, candidate) => preferVerifiedDurableBoundary(
        current, verifiedDurableBoundaryOf(candidate.checkpoint, candidate.checkpointKey),
      ),
      liveDurableBoundarySource(store, this.boundary) ? this.boundary : undefined,
    );
  }

  /** A refused seed ends cross-peer seeding for this run, with one own-state retry per peer. */
  startRun(store: SyncCheckpointStore) {
    let seedingRefused = false;
    let rejectedPeer: string | undefined;
    const retried = new Set<string>();
    return {
      discover: (candidates: readonly { checkpointKey: string; checkpoint: SyncCheckpointEntry | undefined }[]) => {
        this.remember(store, candidates);
      },
      seed: (peerId: string, checkpointKey: string): { kind: 'seeded'; offset: number } | { kind: 'own-checkpoint' } => {
        const boundary = seedingRefused ? undefined : this.boundary;
        if (boundary && this.refusedByPeer.get(peerId) !== durableBoundaryIdentity(boundary.manifestDigest, boundary.offset)
          && seedVerifiedDurableBoundary(store, checkpointKey, boundary)) {
          return { kind: 'seeded', offset: boundary.offset };
        }
        return { kind: 'own-checkpoint' };
      },
      recordSlice: (input: {
        peerId: string; checkpointKey: string; before: SyncCheckpointEntry | undefined;
        after: SyncCheckpointEntry | undefined; rejectedOffset: number | undefined; seeded: boolean;
      }) => {
        rejectedPeer = input.rejectedOffset === undefined ? undefined : input.peerId;
        if (input.rejectedOffset !== undefined) {
          this.refusedByPeer.set(input.peerId, durableBoundaryIdentity(input.before?.manifestDigest, input.rejectedOffset));
          if (input.seeded) seedingRefused = true;
        }
        this.remember(store, [{ checkpointKey: input.checkpointKey, checkpoint: input.after }]);
      },
      retryRejectedSlice: (peerId: string): boolean => {
        if (rejectedPeer !== peerId || retried.has(peerId)) return false;
        retried.add(peerId);
        return true;
      },
    };
  }
}
