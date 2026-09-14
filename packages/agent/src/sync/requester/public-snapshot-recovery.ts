import type { Quad } from '@origintrail-official/dkg-storage';
import { workspacePublicQuadsDigest, type WorkspacePublicSnapshotStore } from '@origintrail-official/dkg-publisher';
import { combineSyncFailures } from '../error-tags.js';
import {
  sharedMemoryWorkOutcome,
  type SharedMemoryWorkOutcome,
} from '../shared-memory-completion.js';
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
 * Why one position stayed unresolved, in the shared bounded-work vocabulary.
 *
 * `local-budget-yield` is OUR admission decision — the shared allowance ran out
 * before this ref's cache check or dispatch, or the page itself yielded on it —
 * and is never peer evidence. `timed-out` and `incomplete` are independent
 * shortfalls the peer or the stream produced. One vocabulary is enough: pages
 * already report their completion in it, and so does the round below.
 */
type SnapshotShortfall = Exclude<SharedMemoryWorkOutcome, 'completed'>;

/** Peer evidence outranks our own yield; a timeout outranks a plain shortfall. */
const SHORTFALL_RANK: Readonly<Record<SnapshotShortfall, number>> = Object.freeze({
  'local-budget-yield': 0, incomplete: 1, 'timed-out': 2,
});

function strongerShortfall(
  carried: SnapshotShortfall | undefined,
  settled: SnapshotShortfall,
): SnapshotShortfall {
  return carried === undefined || SHORTFALL_RANK[settled] > SHORTFALL_RANK[carried] ? settled : carried;
}

type SnapshotAttempt =
  | { readonly kind: 'ready'; readonly metrics: SnapshotMetrics }
  | {
    readonly kind: 'missing';
    readonly outcome: SnapshotShortfall;
    /**
     * Whether this position ends the round's dispatch. A cleanly terminated
     * short prefix does not: the ref is retried from offset zero next round and
     * the remaining entries are still worth admitting.
     */
    readonly halts: boolean;
    readonly metrics: SnapshotMetrics;
  }
  | { readonly kind: 'fatal'; readonly error: unknown; readonly metrics: SnapshotMetrics };

/** One manifest position together with the owner's reuse decision for it. */
export interface PublicSnapshotWalkEntry {
  readonly snapshot: PublicSnapshotMetadata;
  readonly reuse: boolean;
}

/**
 * Immutable manifest order and validated reuse decisions for one pass.
 *
 * Owned here with the entry it is made of, so a plan built by a walk owner and
 * the positions this module attempts cannot drift apart structurally.
 */
export interface PublicSnapshotWalkPlan {
  readonly entries: readonly PublicSnapshotWalkEntry[];
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

/** The canonical result of one settled walk; every caller reads this shape. */
export interface PublicSnapshotRecoveryResult extends PublicSnapshotWalkProgress, SnapshotMetrics {
  readonly completed: boolean;
  /**
   * How the round itself ended, reduced once from the settled positions in the
   * shared bounded-work vocabulary. `local-budget-yield` means every unresolved
   * position was our own admission decision.
   */
  readonly outcome: SharedMemoryWorkOutcome;
  /**
   * At least one unresolved position was our own admission decision — evidence
   * the owning round merges, independent of which cause finally classified the
   * round. A yield mixed with peer evidence still sets this and still leaves
   * `outcome` on the peer's cause.
   */
  readonly localYield?: true;
}

export type PublicSnapshotRecoveryOutcome =
  | { readonly kind: 'result'; readonly result: PublicSnapshotRecoveryResult }
  | { readonly kind: 'failure'; readonly result: PublicSnapshotRecoveryResult; readonly error: unknown };

export interface PublicSnapshotRecoveryParams extends Omit<SnapshotRecoveryPorts, 'store'> {
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

/** The allowance ran out before this position did anything, so it received nothing. */
const LOCAL_YIELD_BEFORE_WORK: SnapshotAttempt = Object.freeze({
  kind: 'missing', outcome: 'local-budget-yield', halts: true, metrics: EMPTY_METRICS,
});

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
    if (!ports.workAdmission.canAdmitWork()) return LOCAL_YIELD_BEFORE_WORK;
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
    if (!ports.workAdmission.canAdmitWork()) return LOCAL_YIELD_BEFORE_WORK;
    const result = await boundary.read(() => ports.fetchSnapshot(snapshot, boundary.signal));
    metrics = {
      bytesReceived: result.bytesReceived,
      resumedPhases: result.resumedFromOffset > 0 ? 1 : 0,
      timedOutPhases: result.timedOut ? 1 : 0,
      completedPhases: 0,
    };
    // Unverified prefixes cannot be resumed against the whole signed digest.
    boundary.admitSyncMutation(() => ports.deleteCheckpoint(result.checkpointKey));
    // The page already states how it ended in the shared vocabulary — a yield
    // on our allowance is our decision, a timeout or any other incomplete
    // stream is the peer's — so classify it with the same derivation every
    // other bounded-work boundary uses rather than a second taxonomy.
    const pageOutcome = sharedMemoryWorkOutcome(result);
    if (pageOutcome !== 'completed') {
      return { kind: 'missing', outcome: pageOutcome, halts: true, metrics };
    }
    const quads = result.quads.map(quad => ({ ...quad, graph: '' }));
    if (quads.length < snapshot.count) {
      // A cleanly terminated short prefix is missing, not corrupt. Other refs
      // remain useful; retry this immutable ref from offset zero next round.
      return { kind: 'missing', outcome: 'incomplete', halts: false, metrics };
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
      } else if (outcome.kind === 'missing' && outcome.halts) {
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

/**
 * Walk one manifest and settle.
 *
 * Every RUNTIME failure — a per-position fault, and a revoked execution
 * boundary before or after the pool drains — comes back as
 * `{ kind: 'failure', result, error }`, with the progress that was already
 * settled. A caller therefore never loses accounted work to a rejected
 * promise. The only rejections left are programmer errors in the call itself:
 * an out-of-range `concurrency` and a missing snapshot store, both of which
 * are raised before any position is attempted.
 */
export async function settlePublicSnapshots(params: PublicSnapshotRecoveryParams): Promise<PublicSnapshotRecoveryOutcome> {
  const concurrency = params.concurrency ?? SEQUENTIAL_SNAPSHOT_WALK_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > PUBLIC_SNAPSHOT_FETCH_CONCURRENCY) {
    throw new RangeError(`Public snapshot fetch concurrency must be between 1 and ${PUBLIC_SNAPSHOT_FETCH_CONCURRENCY}`);
  }
  const progress = {
    ...EMPTY_METRICS,
    readySnapshots: 0, totalSnapshots: params.entries.length,
    missingCount: 0, missingSample: [] as string[],
  };
  // A boundary revoked before any work still settles: an empty walk is
  // progress a caller can account, not a rejected promise.
  const entryRevocation = boundaryRevocation(params.executionBoundary);
  if (entryRevocation !== undefined) {
    return { kind: 'failure', result: { ...progress, completed: false, outcome: 'incomplete' }, error: entryRevocation };
  }
  if (params.entries.length === 0) {
    return { kind: 'result', result: { ...progress, completed: true, outcome: 'completed' } };
  }
  if (!params.store) {
    throw new Error(`Cannot sync shared-memory public snapshot refs for "${params.contextGraphId}" without a public snapshot store`);
  }
  const { outcomes, failures } = await runSnapshotPool(params.entries, concurrency, { ...params, store: params.store });
  // Revocation while the pool drained is a runtime failure like any other: it
  // joins the failure branch instead of discarding the settled positions.
  const drainRevocation = boundaryRevocation(params.executionBoundary);
  let localYield = false;
  let shortfall: SnapshotShortfall | undefined;
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
    // the outcomes that actually settled attribute the shortfall. A fatal
    // position is independent evidence too — the error it carries says which
    // kind — so it cannot leave the round classified as our own yield.
    if (!outcome) continue;
    const settled = outcome.kind === 'missing' ? outcome.outcome : 'incomplete';
    if (settled === 'local-budget-yield') localYield = true;
    shortfall = strongerShortfall(shortfall, settled);
  }
  const completed = progress.missingCount === 0;
  const result: PublicSnapshotRecoveryResult = {
    ...progress,
    completed,
    // One classification for the round, reduced from the positions that
    // settled: peer or stream evidence if any, otherwise our own yield.
    outcome: completed ? 'completed' : shortfall ?? 'incomplete',
    ...(localYield ? { localYield: true as const } : {}),
  };
  const causes = drainRevocation === undefined ? failures : [...failures, drainRevocation];
  return causes.length > 0
    ? { kind: 'failure', result, error: combineSyncFailures(causes[0], causes.slice(1)) }
    : { kind: 'result', result };
}

/** The reason a boundary is no longer current, or `undefined` while it is. */
function boundaryRevocation(boundary: RecoveryExecutionAdmission): unknown {
  try {
    boundary.assertCurrent();
    return undefined;
  } catch (error) {
    return error;
  }
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
