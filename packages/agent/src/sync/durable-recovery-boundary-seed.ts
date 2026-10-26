// SPDX-License-Identifier: Apache-2.0
import type {
  DurableManifestDigest,
  DurableManifestPrefixDigest,
  SyncCheckpointEntry,
  SyncCheckpointStore,
} from './checkpoint/state.js';
import { resolveManifestCheckpointDecision } from './requester/manifest-resume-policy.js';
import type { DurableMetaContinuation } from './requester/durable-sync.js';

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
 * Read and clear the offset at which the slice's DATA round found that the
 * peer's rows did not line up with the boundary it resumed at, if it did.
 */
export function takeRejectedResumeOffset(
  continuation: Pick<DurableMetaContinuation, 'rejectedResumeOffset'> | undefined,
): number | undefined {
  const offset = continuation?.rejectedResumeOffset;
  if (continuation) continuation.rejectedResumeOffset = undefined;
  return offset;
}

/** A live, non-terminal source that advances the peer's own checkpoint. */
export function eligibleDurableBoundarySource(
  store: SyncCheckpointStore, checkpointKey: string, boundary: VerifiedDurableBoundary | undefined,
): SyncCheckpointEntry | undefined {
  if (!boundary || boundary.terminal) return undefined;
  const source = liveDurableBoundarySource(store, boundary);
  const current = store.get(checkpointKey);
  return source && (!current || current.offset < boundary.offset) ? source : undefined;
}

/** Install a proposed boundary only after this peer's completed META proves it. */
export function seedVerifiedDurableBoundary(
  store: SyncCheckpointStore,
  checkpointKey: string,
  boundary: VerifiedDurableBoundary | undefined,
  proof: {
    manifestDigest?: DurableManifestDigest;
    prefixDigestAtOffset?: (offset: number) => DurableManifestPrefixDigest | undefined;
    clearCheckpoint: () => void;
  },
): boolean {
  const source = eligibleDurableBoundarySource(store, checkpointKey, boundary);
  if (!source || !proof.manifestDigest) return false;
  // The source's raw responder coordinate belongs to another peer. Only its
  // verified manifest boundary is proposed; the destination keeps its own
  // checkpoint and session until that boundary is proven by its current META.
  const decision = resolveManifestCheckpointDecision({
    checkpoint: { ...source, responderSessionOffset: undefined },
    manifestDigest: proof.manifestDigest,
    prefixDigestAtOffset: proof.prefixDigestAtOffset?.(source.offset),
    hasExactAssetFilter: false,
  });
  if (decision.kind === 'reset') return false;
  proof.clearCheckpoint();
  store.setManifestBoundOffset(checkpointKey, source.offset, source.manifestDigest!,
    source.updatedAtMs, source.manifestPrefixDigest);
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
      seed: (peerId: string, checkpointKey: string): { kind: 'candidate'; boundary: VerifiedDurableBoundary } | { kind: 'own-checkpoint' } => {
        const boundary = seedingRefused ? undefined : this.boundary;
        if (boundary && this.refusedByPeer.get(peerId) !== durableBoundaryIdentity(boundary.manifestDigest, boundary.offset)
          && eligibleDurableBoundarySource(store, checkpointKey, boundary)) {
          return { kind: 'candidate', boundary };
        }
        return { kind: 'own-checkpoint' };
      },
      recordSlice: (input: {
        peerId: string; checkpointKey: string; before: SyncCheckpointEntry | undefined;
        after: SyncCheckpointEntry | undefined; rejectedOffset: number | undefined; candidate?: VerifiedDurableBoundary;
      }) => {
        rejectedPeer = input.rejectedOffset === undefined ? undefined : input.peerId;
        if (input.rejectedOffset !== undefined) {
          const seeded = input.candidate?.offset === input.rejectedOffset;
          this.refusedByPeer.set(input.peerId, durableBoundaryIdentity(
            seeded ? input.candidate!.manifestDigest : input.before?.manifestDigest, input.rejectedOffset,
          ));
          if (seeded) seedingRefused = true;
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
