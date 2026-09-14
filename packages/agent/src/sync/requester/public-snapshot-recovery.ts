import type { Quad } from '@origintrail-official/dkg-storage';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { combineSyncFailures } from '../error-tags.js';
import type { SyncWorkAdmission } from '../work-admission.js';
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

/**
 * Why one ref stayed unresolved. `local-yield` is OUR admission decision — the
 * shared allowance ran out before this ref's cache check or dispatch, or the
 * page fetch itself yielded on it — and is never peer evidence. The other two
 * are independent shortfalls produced by the peer or the stream.
 */
type SnapshotShortfall = 'local-yield' | 'incomplete' | 'short-prefix';

type SnapshotAttempt =
  | { readonly kind: 'ready'; readonly metrics: SnapshotMetrics }
  | { readonly kind: 'missing'; readonly reason: SnapshotShortfall; readonly metrics: SnapshotMetrics }
  | { readonly kind: 'fatal'; readonly error: unknown; readonly metrics: SnapshotMetrics };

/** One manifest position together with the owner's reuse decision for it. */
export interface PublicSnapshotWalkEntry {
  readonly snapshot: PublicSnapshotMetadata;
  readonly reuse: boolean;
}

interface SnapshotRecoveryPorts {
  /** Shared job-window and round-deadline capability, consulted before every cache read and dispatch. */
  readonly workAdmission: SyncWorkAdmission;
  readonly store: WorkspacePublicSnapshotStore;
  readonly executionBoundary: RecoveryExecutionAdmission;
  readonly fetchSnapshot: (snapshot: PublicSnapshotMetadata, signal?: AbortSignal) => Promise<SyncPageResult>;
  readonly deleteCheckpoint: (key: string) => void;
  readonly onSnapshotReady?: (snapshot: PublicSnapshotMetadata, source: 'cache' | 'network') => Promise<void>;
}

export interface PublicSnapshotRecoveryResult extends PublicSnapshotWalkProgress, SnapshotMetrics {
  readonly completed: boolean;
  /** Distinct causes represented by the settled unresolved positions. */
  readonly shortfallCauses?: readonly ('local-admission' | 'independent')[];
}

export type PublicSnapshotRecoveryOutcome =
  | { readonly kind: 'result'; readonly result: PublicSnapshotRecoveryResult }
  | { readonly kind: 'failure'; readonly result: PublicSnapshotRecoveryResult; readonly error: unknown };

interface PublicSnapshotRecoveryParams extends Omit<SnapshotRecoveryPorts, 'store'> {
  /** Immutable manifest order; the owner has already decided each position's reuse. */
  readonly entries: readonly PublicSnapshotWalkEntry[];
  readonly contextGraphId: string;
  /**
   * Pool size for this walk, OPT-IN.
   *
   * Omitted means sequential. The fetch, store and materialization ports are
   * the caller's own, and this walk invoked them one at a time before the
   * bounded pool existed; a caller that never asked for a pool must not have
   * its non-reentrant `onSnapshotReady` transaction — or any other port —
   * entered twice at once. A path that owns its ports requests
   * {@link PUBLIC_SNAPSHOT_FETCH_CONCURRENCY} explicitly.
   */
  readonly concurrency?: number;
  readonly store?: WorkspacePublicSnapshotStore;
}

/** One operation owns its metrics and always settles into a discriminated result. */
async function attemptSnapshot({ snapshot, reuse }: PublicSnapshotWalkEntry, ports: SnapshotRecoveryPorts): Promise<SnapshotAttempt> {
  const boundary = ports.executionBoundary;
  let metrics = EMPTY_METRICS;
  try {
    boundary.assertCurrent();
    // The owner decides which manifest-bound evidence this pass can reuse.
    // Skipping the blob and assertion validation it already established
    // leaves the allowance for unresolved refs to advance.
    if (reuse) return { kind: 'ready', metrics };
    // Admission BEFORE any work for this ref: cache validation can require a
    // full read and digest, and a miss is a network round trip. No
    // `SyncPageResult` exists yet, so `timedOutPhases` structurally cannot
    // move here — a local budget decision never reads as a peer timeout.
    if (!ports.workAdmission.canAdmitWork()) return { kind: 'missing', reason: 'local-yield', metrics };
    if (await boundary.read(() => hasValidSnapshot(ports.store, snapshot))) {
      if (ports.onSnapshotReady) {
        boundary.assertCurrent();
        await ports.onSnapshotReady(snapshot, 'cache');
        boundary.assertCurrent();
      }
      return { kind: 'ready', metrics };
    }

    // Cache validation can consume the allowance without producing a hit.
    // Admit no new transport after that local work exhausts the budget.
    if (!ports.workAdmission.canAdmitWork()) return { kind: 'missing', reason: 'local-yield', metrics };
    const result = await boundary.read(() => ports.fetchSnapshot(snapshot, boundary.signal));
    metrics = {
      bytesReceived: result.bytesReceived,
      resumedPhases: result.resumedFromOffset > 0 ? 1 : 0,
      timedOutPhases: result.timedOut ? 1 : 0,
      completedPhases: 0,
    };
    // Unverified prefixes cannot be resumed against the whole signed digest.
    boundary.admitSyncMutation(() => ports.deleteCheckpoint(result.checkpointKey));
    // A page that yielded on the shared allowance is our decision as well,
    // not an independent shortfall; any other incomplete stream is one.
    if (!result.completed) {
      return { kind: 'missing', reason: result.localYield ? 'local-yield' : 'incomplete', metrics };
    }
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
  entries: readonly PublicSnapshotWalkEntry[],
  concurrency: number,
  ports: SnapshotRecoveryPorts,
): Promise<{ outcomes: Array<SnapshotAttempt | undefined>; failures: unknown[] }> {
  const outcomes: Array<SnapshotAttempt | undefined> = Array.from({ length: entries.length });
  const failures: unknown[] = [];
  let nextIndex = 0;
  let halted = false;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (halted || nextIndex >= entries.length) return;
      const index = nextIndex++;
      const outcome = await attemptSnapshot(entries[index]!, ports);
      outcomes[index] = outcome;
      if (outcome.kind === 'fatal') {
        halted = true;
        // Completion order owns the triggering cause; reporting remains in
        // manifest order. At most the already-admitted siblings can add errors.
        failures.push(outcome.error);
      } else if (outcome.kind === 'missing' && outcome.reason !== 'short-prefix') {
        // Stop taking entries after an incomplete stream or exhausted local
        // allowance. Already admitted siblings still drain through this loop.
        halted = true;
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, entries.length) },
    () => worker(),
  ));
  return { outcomes, failures };
}

/** Recover one manifest with a bounded pool and one ordered progress reduction. */
export async function recoverPublicSnapshots(params: PublicSnapshotRecoveryParams): Promise<PublicSnapshotRecoveryResult> {
  const outcome = await settlePublicSnapshots(params);
  if (outcome.kind === 'failure') throw outcome.error;
  return outcome.result;
}

/** Let the owning sync round account every admitted outcome before rethrowing. */
export async function settlePublicSnapshots(params: PublicSnapshotRecoveryParams): Promise<PublicSnapshotRecoveryOutcome> {
  params.executionBoundary.assertCurrent();
  const concurrency = params.concurrency ?? SEQUENTIAL_SNAPSHOT_WALK_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > PUBLIC_SNAPSHOT_FETCH_CONCURRENCY) {
    throw new RangeError(`Public snapshot fetch concurrency must be between 1 and ${PUBLIC_SNAPSHOT_FETCH_CONCURRENCY}`);
  }
  const progress = {
    ...EMPTY_METRICS,
    readySnapshots: 0, totalSnapshots: params.entries.length,
    missingCount: 0, missingSample: [] as string[],
  };
  if (params.entries.length === 0) return { kind: 'result', result: { ...progress, completed: true } };
  if (!params.store) {
    throw new Error(`Cannot sync shared-memory public snapshot refs for "${params.contextGraphId}" without a public snapshot store`);
  }
  const { outcomes, failures } = await runSnapshotPool(params.entries, concurrency, { ...params, store: params.store });
  params.executionBoundary.assertCurrent();
  let localYield = false;
  let hasIndependentShortfall = false;
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome) {
      progress.bytesReceived += outcome.metrics.bytesReceived;
      progress.resumedPhases += outcome.metrics.resumedPhases;
      progress.timedOutPhases += outcome.metrics.timedOutPhases;
      progress.completedPhases += outcome.metrics.completedPhases;
    }
    if (outcome?.kind === 'ready') {
      progress.readySnapshots++;
      continue;
    }
    progress.missingCount++;
    if (progress.missingSample.length < PUBLIC_SNAPSHOT_MISSING_SAMPLE_LIMIT) {
      progress.missingSample.push(boundSampledRef(params.entries[index]!.snapshot.ref));
    }
    // Positions abandoned after a halt carry no evidence of their own; only
    // the outcomes that actually settled attribute the shortfall.
    if (outcome?.kind === 'missing' && outcome.reason === 'local-yield') localYield = true;
    else if (outcome) hasIndependentShortfall = true;
  }
  // The single-phase attribution the owning round records: solely local
  // admission, or at least one shortfall the peer or the stream produced.
  const shortfallCauses = [
    ...(localYield ? ['local-admission' as const] : []),
    ...(hasIndependentShortfall ? ['independent' as const] : []),
  ];
  const result: PublicSnapshotRecoveryResult = {
    ...progress,
    completed: progress.missingCount === 0,
    ...(shortfallCauses.length === 0 ? {} : { shortfallCauses }),
  };
  return failures.length > 0
    ? { kind: 'failure', result, error: combineSyncFailures(failures[0], failures.slice(1)) }
    : { kind: 'result', result };
}

/**
 * Cap on identifiers reported for an unresolved manifest. A public peer chooses
 * how many snapshots it advertises, so an unbounded list would let it size a
 * structure on this node; the exact figure travels as `missingCount`.
 */
export const PUBLIC_SNAPSHOT_MISSING_SAMPLE_LIMIT = 10;

/**
 * Upper bound for a requester round that ASKS for the pool; the shared
 * responder admission policy still applies. It is the ceiling this module
 * validates against and the figure a path that owns its ports opts into — never
 * a default applied to a caller that requested nothing.
 */
export const PUBLIC_SNAPSHOT_FETCH_CONCURRENCY = 4;

/**
 * What an omitted pool limit means: one operation at a time, so a caller's
 * ports are never entered concurrently without asking.
 */
const SEQUENTIAL_SNAPSHOT_WALK_CONCURRENCY = 1;
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

/** Manifest-ordered progress from one settled snapshot walk. */
export interface PublicSnapshotWalkProgress {
  readySnapshots: number;
  totalSnapshots: number;
  missingCount: number;
  missingSample: string[];
}

async function hasValidSnapshot(
  publicSnapshotStore: WorkspacePublicSnapshotStore,
  snapshot: PublicSnapshotMetadata,
): Promise<boolean> {
  let quads: Quad[] | null;
  try {
    if (publicSnapshotStore.validateSnapshot) {
      return await publicSnapshotStore.validateSnapshot(snapshot.ref, snapshot.digest, snapshot.count);
    }
    quads = await publicSnapshotStore.getSnapshot(snapshot.ref);
  } catch {
    return false;
  }
  if (!quads) return false;
  return quads.length === snapshot.count && workspacePublicQuadsDigest(quads) === snapshot.digest;
}
