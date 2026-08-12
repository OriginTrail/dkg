import type {
  DurableManifestDigest,
  SyncCheckpointEntry,
} from './checkpoint/state.js';

export type DurableRecoveryContinuationOutcome =
  | 'terminal'
  | 'partial-progress'
  | 'no-progress'
  | 'incompatible';

export interface DurableRecoverySliceEvidence {
  readonly terminalPersisted: boolean;
  readonly checkpointAdvanced: boolean;
  readonly manifestRebound: boolean;
  readonly deniedPhases: number;
  readonly rejectedKcs: number;
  readonly dataRejectedMissingMeta: number;
}

/** Classify one bounded physical transfer without conflating progress with failure. */
export function classifyDurableRecoverySlice(
  evidence: DurableRecoverySliceEvidence,
): DurableRecoveryContinuationOutcome {
  if (evidence.terminalPersisted) return 'terminal';
  if (
    evidence.checkpointAdvanced
    || evidence.manifestRebound
  ) return 'partial-progress';
  if (
    evidence.deniedPhases > 0
    || evidence.rejectedKcs > 0
    || evidence.dataRejectedMissingMeta > 0
  ) return 'incompatible';
  return 'no-progress';
}

export interface DurableRecoveryPeerHealth {
  readonly attempts: number;
  readonly successfulSlices: number;
  readonly recentTimeouts: number;
  readonly recentTransportResets: number;
  readonly lastSuccessfulTransportAtMs?: number;
}

export interface DurableRecoveryPeerCandidate<TPeer = string> {
  readonly peer: TPeer;
  readonly peerId: string;
  readonly checkpoint?: SyncCheckpointEntry;
  readonly health?: DurableRecoveryPeerHealth;
  /** Stable order supplied by curator/core selection before checkpoint ranking. */
  readonly discoveryRank: number;
}

function recentFailureRate(health: DurableRecoveryPeerHealth | undefined): number {
  if (!health || health.attempts <= 0) return 0;
  return (health.recentTimeouts + health.recentTransportResets) / health.attempts;
}

/**
 * Select the already-verified manifest with the greatest durable prefix.
 *
 * A manifest digest is never inferred from raw peer metadata here. Every input
 * came from the checkpoint store only after the manifest and its prefix passed
 * the durable integrity boundary. Ties prefer the most recently refreshed
 * checkpoint so an appended, prefix-compatible generation can replace an old
 * one without throwing away the common verified prefix.
 */
export function selectCanonicalDurableRecoveryManifest(
  candidates: readonly DurableRecoveryPeerCandidate[],
): DurableManifestDigest | undefined {
  return candidates
    .filter((candidate) => candidate.checkpoint?.manifestDigest !== undefined)
    .sort((left, right) => (
      (right.checkpoint?.offset ?? 0) - (left.checkpoint?.offset ?? 0)
      || (right.checkpoint?.updatedAtMs ?? 0) - (left.checkpoint?.updatedAtMs ?? 0)
      || left.discoveryRank - right.discoveryRank
    ))[0]?.checkpoint?.manifestDigest;
}

/**
 * Rank responders for the next bounded durable-recovery slice.
 *
 * The ordering is deliberately lexicographic, matching the recovery contract:
 * same verified manifest, greatest safe prefix, most recent successful
 * transport, lowest recent timeout/reset rate, then the stable curator/core
 * discovery order. A peer with no checkpoint remains eligible as a fallback,
 * but cannot displace one that can continue a verified prefix.
 */
export function rankDurableRecoveryPeers<TPeer>(
  candidates: readonly DurableRecoveryPeerCandidate<TPeer>[],
  canonicalManifestDigest?: DurableManifestDigest,
): DurableRecoveryPeerCandidate<TPeer>[] {
  return [...candidates].sort((left, right) => {
    const leftSameManifest = canonicalManifestDigest !== undefined
      && left.checkpoint?.manifestDigest === canonicalManifestDigest;
    const rightSameManifest = canonicalManifestDigest !== undefined
      && right.checkpoint?.manifestDigest === canonicalManifestDigest;
    if (leftSameManifest !== rightSameManifest) return leftSameManifest ? -1 : 1;

    const checkpointDelta = (right.checkpoint?.offset ?? 0) - (left.checkpoint?.offset ?? 0);
    if (checkpointDelta !== 0) return checkpointDelta;

    const successDelta = (right.health?.lastSuccessfulTransportAtMs ?? 0)
      - (left.health?.lastSuccessfulTransportAtMs ?? 0);
    if (successDelta !== 0) return successDelta;

    const failureRateDelta = recentFailureRate(left.health) - recentFailureRate(right.health);
    if (failureRateDelta !== 0) return failureRateDelta;

    return left.discoveryRank - right.discoveryRank;
  });
}

interface ActiveDurableRecovery<T> {
  manifestDigest?: DurableManifestDigest;
  promise: Promise<T>;
}

export interface DurableRecoveryOwnerControl {
  readonly contextGraphId: string;
  readonly manifestDigest?: DurableManifestDigest;
  bindManifest(manifestDigest: DurableManifestDigest): void;
  /** Release the current scheduler turn before exactly one continuation slice. */
  scheduleContinuation(): Promise<void>;
}

/**
 * One physical durable recovery owner per Context Graph and canonical manifest.
 *
 * `activeByContextGraph` is intentional as well as the manifest-qualified map:
 * a trigger that has not fetched META yet cannot name the digest, and must join
 * the graph's discovery owner rather than starting a competing transfer. Once
 * the first verified checkpoint binds the owner, later callers address the
 * `(Context Graph, manifest digest)` identity directly while unbound callers
 * still join the same physical promise.
 */
export class DurableRecoveryCoordinator<T> {
  private readonly activeByContextGraph = new Map<string, ActiveDurableRecovery<T>>();

  private readonly activeByManifest = new Map<string, ActiveDurableRecovery<T>>();

  join(input: {
    contextGraphId: string;
    manifestDigest?: DurableManifestDigest;
    runOwner: (control: DurableRecoveryOwnerControl) => Promise<T>;
  }): Promise<T> {
    const manifestKey = input.manifestDigest === undefined
      ? undefined
      : DurableRecoveryCoordinator.manifestKey(input.contextGraphId, input.manifestDigest);
    const existing = (manifestKey ? this.activeByManifest.get(manifestKey) : undefined)
      ?? this.activeByContextGraph.get(input.contextGraphId);
    if (existing) return existing.promise;

    let entry!: ActiveDurableRecovery<T>;
    const control: DurableRecoveryOwnerControl = {
      contextGraphId: input.contextGraphId,
      get manifestDigest() {
        return entry.manifestDigest;
      },
      bindManifest: (manifestDigest) => {
        if (entry.manifestDigest === manifestDigest) return;
        if (entry.manifestDigest !== undefined) {
          this.activeByManifest.delete(DurableRecoveryCoordinator.manifestKey(
            input.contextGraphId,
            entry.manifestDigest,
          ));
        }
        entry.manifestDigest = manifestDigest;
        this.activeByManifest.set(
          DurableRecoveryCoordinator.manifestKey(input.contextGraphId, manifestDigest),
          entry,
        );
      },
      scheduleContinuation: () => new Promise<void>((resolve) => setImmediate(resolve)),
    };

    const promise = Promise.resolve()
      .then(() => input.runOwner(control))
      .finally(() => {
        if (this.activeByContextGraph.get(input.contextGraphId) === entry) {
          this.activeByContextGraph.delete(input.contextGraphId);
        }
        if (entry.manifestDigest !== undefined) {
          const key = DurableRecoveryCoordinator.manifestKey(
            input.contextGraphId,
            entry.manifestDigest,
          );
          if (this.activeByManifest.get(key) === entry) this.activeByManifest.delete(key);
        }
      });
    entry = { manifestDigest: input.manifestDigest, promise };
    this.activeByContextGraph.set(input.contextGraphId, entry);
    if (manifestKey) this.activeByManifest.set(manifestKey, entry);
    return promise;
  }

  private static manifestKey(
    contextGraphId: string,
    manifestDigest: DurableManifestDigest,
  ): string {
    return `${contextGraphId}\0${manifestDigest}`;
  }
}
