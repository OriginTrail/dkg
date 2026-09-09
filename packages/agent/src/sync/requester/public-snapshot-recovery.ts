import type { Quad } from '@origintrail-official/dkg-storage';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { mapWithConcurrency } from '../../map-with-concurrency.js';
import { combineSyncFailures } from '../error-tags.js';
import type { SyncPageResult } from './page-fetch.js';
import type { RecoveryExecutionAdmission } from './recovery-execution-guard.js';

interface SnapshotMetrics {
  readonly bytesReceived: number;
  readonly resumedPhases: number;
  readonly timedOutPhases: number;
  readonly completedPhases: number;
}

const EMPTY_METRICS: SnapshotMetrics = Object.freeze({
  bytesReceived: 0, resumedPhases: 0, timedOutPhases: 0, completedPhases: 0,
});

type SnapshotAttempt =
  | { readonly kind: 'ready'; readonly metrics: SnapshotMetrics }
  | { readonly kind: 'missing'; readonly reason: 'deadline' | 'incomplete' | 'short-prefix'; readonly metrics: SnapshotMetrics }
  | { readonly kind: 'fatal'; readonly error: unknown; readonly metrics: SnapshotMetrics };
type ScheduledSnapshot = SnapshotAttempt | { readonly kind: 'not-started' };

interface SnapshotRecoveryPorts {
  readonly deadline: number;
  readonly store: WorkspacePublicSnapshotStore;
  readonly executionBoundary: RecoveryExecutionAdmission;
  readonly isResolved?: (ref: string) => boolean;
  readonly fetchSnapshot: (snapshot: PublicSnapshotMetadata, signal?: AbortSignal) => Promise<SyncPageResult>;
  readonly deleteCheckpoint: (key: string) => void;
  readonly onSnapshotReady?: (snapshot: PublicSnapshotMetadata, source: 'cache' | 'network') => Promise<void>;
}

export interface PublicSnapshotRecoveryResult extends PublicSnapshotWalkProgress, SnapshotMetrics {
  readonly checkpointAdvances: number;
  readonly completed: boolean;
  readonly yieldedAtDeadline: boolean;
}

/** One operation owns its metrics and always settles into a discriminated result. */
async function attemptSnapshot(snapshot: PublicSnapshotMetadata, ports: SnapshotRecoveryPorts): Promise<SnapshotAttempt> {
  const boundary = ports.executionBoundary;
  let metrics = EMPTY_METRICS;
  try {
    boundary.assertCurrent();
    if (ports.isResolved?.(snapshot.ref)) return { kind: 'ready', metrics };
    if (Date.now() >= ports.deadline) return { kind: 'missing', reason: 'deadline', metrics };
    if (await boundary.read(() => hasValidSnapshot(ports.store, snapshot))) {
      if (ports.onSnapshotReady) {
        boundary.assertCurrent();
        await ports.onSnapshotReady(snapshot, 'cache');
        boundary.assertCurrent();
      }
      return { kind: 'ready', metrics };
    }

    // A cache miss may have consumed the round allowance. Do not start a wire
    // request after that deadline or classify a local yield as a peer timeout.
    if (Date.now() >= ports.deadline) return { kind: 'missing', reason: 'deadline', metrics };
    const result = await boundary.read(() => ports.fetchSnapshot(snapshot, boundary.signal));
    metrics = {
      bytesReceived: result.bytesReceived,
      resumedPhases: result.resumedFromOffset > 0 ? 1 : 0,
      timedOutPhases: result.timedOut ? 1 : 0,
      completedPhases: 0,
    };
    // Unverified prefixes cannot be resumed against the whole signed digest.
    boundary.admitSyncMutation(() => ports.deleteCheckpoint(result.checkpointKey));
    if (!result.completed) return { kind: 'missing', reason: 'incomplete', metrics };
    const quads = result.quads.map(quad => ({ ...quad, graph: '' }));
    if (quads.length < snapshot.count) {
      // A cleanly terminated short prefix is missing, not corrupt. Other refs
      // remain useful; retry this immutable ref from offset zero next round.
      return { kind: 'missing', reason: 'short-prefix', metrics };
    }
    const digest = workspacePublicQuadsDigest(quads);
    if (digest !== snapshot.digest || quads.length !== snapshot.count) {
      throw new Error(`Shared-memory public snapshot ${snapshot.ref} failed digest/count validation `
        + `(expected ${snapshot.digest}/${snapshot.count}, got ${digest}/${quads.length})`);
    }
    await boundary.admitAsyncMutation(() => ports.store.putSnapshot({ digest: snapshot.digest, quads }));
    if (ports.onSnapshotReady) {
      boundary.assertCurrent();
      await ports.onSnapshotReady(snapshot, 'network');
      boundary.assertCurrent();
    }
    return { kind: 'ready', metrics: { ...metrics, completedPhases: 1 } };
  } catch (error) {
    return { kind: 'fatal', error, metrics };
  }
}

/** Own admission, halt, and drain separately from per-snapshot effects. */
async function runSnapshotPool(
  snapshots: readonly PublicSnapshotMetadata[],
  concurrency: number,
  ports: SnapshotRecoveryPorts,
): Promise<{ outcomes: ScheduledSnapshot[]; failures: unknown[] }> {
  let halted = false;
  const failures: unknown[] = [];
  const outcomes = await mapWithConcurrency(snapshots, concurrency, async (snapshot): Promise<ScheduledSnapshot> => {
    if (halted) return { kind: 'not-started' };
    const outcome = await attemptSnapshot(snapshot, ports);
    if (outcome.kind === 'fatal') {
      halted = true;
      // Completion order owns the triggering cause; reporting remains in
      // manifest order. At most the already-admitted siblings can add errors.
      failures.push(outcome.error);
    } else if (outcome.kind === 'missing' && outcome.reason === 'incomplete') {
      halted = true;
    }
    return outcome;
  });
  return { outcomes, failures };
}

/** Recover one manifest with a bounded pool and one ordered progress reduction. */
export async function recoverPublicSnapshots(params: Omit<SnapshotRecoveryPorts, 'store'> & {
  readonly snapshots: readonly PublicSnapshotMetadata[];
  readonly contextGraphId: string;
  readonly concurrency?: number;
  readonly store?: WorkspacePublicSnapshotStore;
}): Promise<PublicSnapshotRecoveryResult> {
  params.executionBoundary.assertCurrent();
  const concurrency = params.concurrency ?? PUBLIC_SNAPSHOT_FETCH_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > PUBLIC_SNAPSHOT_FETCH_CONCURRENCY) {
    throw new RangeError(`Public snapshot fetch concurrency must be between 1 and ${PUBLIC_SNAPSHOT_FETCH_CONCURRENCY}`);
  }
  const progress = {
    ...EMPTY_METRICS, checkpointAdvances: 0,
    readySnapshots: 0, totalSnapshots: params.snapshots.length,
    missingCount: 0, missingSample: [] as string[], yieldedAtDeadline: false,
  };
  if (params.snapshots.length === 0) return { ...progress, completed: true };
  if (!params.store) {
    throw new Error(`Cannot sync shared-memory public snapshot refs for "${params.contextGraphId}" without a public snapshot store`);
  }
  const { outcomes, failures } = await runSnapshotPool(params.snapshots, concurrency, { ...params, store: params.store });
  params.executionBoundary.assertCurrent();
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.kind !== 'not-started') {
      progress.bytesReceived += outcome.metrics.bytesReceived;
      progress.resumedPhases += outcome.metrics.resumedPhases;
      progress.timedOutPhases += outcome.metrics.timedOutPhases;
      progress.completedPhases += outcome.metrics.completedPhases;
    }
    if (outcome.kind === 'ready') progress.readySnapshots++;
    else {
      progress.missingCount++;
      if (progress.missingSample.length < PUBLIC_SNAPSHOT_MISSING_SAMPLE_LIMIT) {
        progress.missingSample.push(boundSampledRef(params.snapshots[index]!.ref));
      }
      if (outcome.kind === 'missing' && outcome.reason === 'deadline') progress.yieldedAtDeadline = true;
    }
  }
  if (failures.length > 0) {
    const error = combineSyncFailures(failures[0], failures.slice(1));
    attachPublicSnapshotWalkProgress(error, {
      readySnapshots: progress.readySnapshots, totalSnapshots: progress.totalSnapshots,
      missingCount: progress.missingCount, missingSample: progress.missingSample,
    });
    throw error;
  }
  return { ...progress, completed: progress.missingCount === 0 };
}

/**
 * Cap on identifiers reported for an unresolved manifest. A public peer chooses
 * how many snapshots it advertises, so an unbounded list would let it size a
 * structure on this node; the exact figure travels as `missingCount`.
 */
export const PUBLIC_SNAPSHOT_MISSING_SAMPLE_LIMIT = 10;

/** Bound each requester round; the shared responder admission policy still applies. */
export const PUBLIC_SNAPSHOT_FETCH_CONCURRENCY = 4;
/**
 * Stored length of ONE sampled ref.
 *
 * A ref is a `dkg:publicSnapshotRef` literal chosen by a remote peer and only
 * `.trim()`ed on the way in, so its length is peer-controlled. Capping the
 * SAMPLE SIZE bounds how many we keep, not how big each one is: ten refs of a
 * megabyte each still cross the worker RPC and sit in the diagnostics record.
 *
 * Bounded at the source as well as at the renderer. The renderer's bound is what
 * protects the operator-facing sentence; this one keeps an oversized literal out
 * of memory and off the wire, which the renderer cannot do from the far side.
 */
const PUBLIC_SNAPSHOT_REF_SAMPLE_MAX_CHARS = 128;

/** Bound one sampled ref. Truncation is marked so it cannot read as complete. */
export function boundSampledRef(ref: string): string {
  return ref.length > PUBLIC_SNAPSHOT_REF_SAMPLE_MAX_CHARS
    ? `${ref.slice(0, PUBLIC_SNAPSHOT_REF_SAMPLE_MAX_CHARS)}\u2026`
    : ref;
}

export interface PublicSnapshotMetadata {
  ref: string;
  digest: string;
  count: number;
  /** Optional, non-authoritative scheduling hint parsed with the manifest. */
  publishedAtMs?: number;
  /** Optional UAL suffix used only as a deterministic recency fallback. */
  ualOrdinal?: bigint;
}

/**
 * Snapshot-walk progress carried OUT of a throw.
 *
 * A snapshot-phase transport failure throws, and the throw unwinds past the
 * point where the caller reads the walk's return value — so a round that
 * materialized 120 Knowledge Assets and then failed on the 121st reported
 * ZERO. That is not merely a diagnostics gap: the continuation loop's progress
 * signal is `swmCoverage.snapshotsResolved`, so the high-water mark never
 * moved, and the loop declared `coverage-stalled` and abandoned a peer that
 * was converging — the exact behaviour #2050 exists to remove.
 *
 * The counts are the walk's own, so `snapshotsResolved + missingCount ===
 * snapshotsTotal` holds on this path exactly as it does on the returned one.
 */
export interface PublicSnapshotWalkProgress {
  readySnapshots: number;
  totalSnapshots: number;
  missingCount: number;
  missingSample: string[];
}

/** Non-enumerable so the payload never widens a structured-clone or log dump. */
const PUBLIC_SNAPSHOT_PROGRESS_KEY = '__swmPublicSnapshotProgress';

function attachPublicSnapshotWalkProgress(err: unknown, progress: PublicSnapshotWalkProgress): void {
  if (typeof err !== 'object' || err === null) return;
  try {
    Object.defineProperty(err, PUBLIC_SNAPSHOT_PROGRESS_KEY, {
      value: progress,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // A frozen or exotic error is not worth failing the round over; the
    // caller simply records no coverage for it, exactly as before.
  }
}

/** Read progress attached by {@link recoverPublicSnapshots} before it rethrew. */
export function readPublicSnapshotWalkProgress(err: unknown): PublicSnapshotWalkProgress | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const progress = (err as Record<string, unknown>)[PUBLIC_SNAPSHOT_PROGRESS_KEY];
  if (typeof progress !== 'object' || progress === null) return undefined;
  const candidate = progress as Partial<PublicSnapshotWalkProgress>;
  // Validated rather than trusted: this crosses an `unknown` boundary, and a
  // fabricated denominator would corrupt the coverage record the pass loop and
  // the terminal message both read.
  if (
    !Number.isSafeInteger(candidate.readySnapshots)
    || !Number.isSafeInteger(candidate.totalSnapshots)
    || !Number.isSafeInteger(candidate.missingCount)
    || !Array.isArray(candidate.missingSample)
  ) {
    return undefined;
  }
  return candidate as PublicSnapshotWalkProgress;
}

async function hasValidSnapshot(
  publicSnapshotStore: WorkspacePublicSnapshotStore,
  snapshot: PublicSnapshotMetadata,
): Promise<boolean> {
  let quads: Quad[] | null;
  try {
    quads = await publicSnapshotStore.getSnapshot(snapshot.ref);
  } catch {
    return false;
  }
  if (!quads) return false;
  return quads.length === snapshot.count && workspacePublicQuadsDigest(quads) === snapshot.digest;
}
