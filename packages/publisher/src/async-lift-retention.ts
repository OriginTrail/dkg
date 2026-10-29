/**
 * Retention of finalized publisher jobs: the core (OT-RFC-73 P11, D-6, AC7).
 *
 * The async publisher queue never deletes a finalized job on its own: rows leave only through an explicit `clear` or `clearTerminalJob`. A node that publishes
 * continuously therefore accumulates its history, and every full-history read grows with it. This module is the engine of an OPT-IN sweep that deletes the finalized
 * jobs the D-6 policy allows (async-lift-retention-policy.ts) under the sibling rule that keeps every binding decision of a lifecycle key as it was
 * (async-lift-lifecycle-siblings.ts). It is deliberately conservative: when in doubt, keep. It has the shape of the share queue's sweep (async-promote-retention.ts) so one
 * timer can run both: a passive object with `runBatch()` and `counters()`, the same modes (`off | report | delete`, default `off`), the same result and counter
 * vocabulary, the same clock guard and hold budget (retention-sweep-core.ts). Nothing wires it here: the mode, the timer and the config are the caller's.
 *
 * One `runBatch()` is one tick:
 *  1. the clock guard (see RetentionClockGuard): a tick is skipped when the wall clock cannot be trusted;
 *  2. one index scan WITHOUT the claim lock, on the background lane, reads up to `batchSize` finalized jobs that look old enough after the keyset cursor
 *     (async-lift-retention-scan.ts);
 *  3. the candidates are processed in SLICES of at most `sliceSize` jobs. Each slice runs INSIDE the queue's claim transaction (async-lift-retention-access.ts), the one
 *     that serializes admission, claims, retries and clears: the payloads and stored index triples are re-read on the control path, the wallet locks are checked, the
 *     records of each candidate's lifecycle key are read the way admission reads them, and the plan of the key (the deletable PREFIX of its records, oldest first) decides. An older
 *     record of the key that this sweep could not delete itself (a payload it does not delete, a stored index the scan does not match) ends the prefix, like a failed one.
 *     In `delete` mode the survivors are removed ONE JOB AT A TIME, oldest first within a key, each through its own job lock from a fresh read, so a failure after any
 *     number of deletes leaves the key's newest record in place and its binding decision as it was. The claim lock is released between slices so admissions and claims
 *     interleave. A hold has a time budget (default 50 ms): no further delete starts once the next one would exceed it, no further key's records are read or verified once
 *     that would (a key left over is judged first by the next hold, and the first key of a hold that cannot verify its records within the budget is kept for the pass), and
 *     the slice size adapts. The store flush runs after the transaction is closed;
 *  4. only after every slice succeeded does the cursor move past the judged rows.
 * `report` mode runs steps 1 to 3 unchanged and removes nothing: the rows it counts as `wouldDelete` are exactly the rows `delete` would remove from the same snapshot (both
 * walk a key's records in one order, see planDeletions), save a key whose older records cannot all be verified within one hold (`siblings_too_many`). Which hold first finds
 * that depends on how fast the store answers, and report, which removes nothing, verifies more of a key's older records than delete, which has removed them.
 * It never throws for a store failure: the result carries the phase that failed and what completed before it (no cursor moves, so the next call judges the same rows
 * again - deleted ones are gone). Throws only for invalid configuration.
 *
 * What a deletion costs a caller: `getStatus(jobId)` of a deleted job becomes `null`, `job-by-intent` answers `none` or lists one record fewer as `superseded`, and a client
 * that lost every reply and retries after the window is admitted as a new job. The journal is append-only (J0) and never touched, and no other graph is.
 *
 * Exclusion between the judgement and the delete is the claim transaction (and the job lock of each removal). A second writer PROCESS that wrote the control graph
 * would not be excluded: retention belongs in the daemon's admission instance only, and the offline inspector refuses to write while a daemon runs.
 */
import { controlStoreOptions } from '@origintrail-official/dkg-storage';
import { isSafeJobId } from './job-id.js';
import { CONTROL_FINALIZED_AT, CONTROL_LIFECYCLE_KEY, CONTROL_LOCKED_JOB, CONTROL_PAYLOAD, CONTROL_STATUS, jobSubject, parseLiteral } from './async-lift-control-plane.js';
import { compareAcceptedJobs, expectBindings, type AcceptanceOrderKey } from './async-lift-publisher-utils.js';
import { decodeLiftJobPayload } from './lift-job-payload-codec.js';
import type { LiftJob, PersistedLiftJob } from './lift-job.js';
import { lifecycleKeyOfJob } from './lift-job-store-selectors.js';
import { isUndecodableSiblingError, keyedIndexAgrees, planKeyDeletion, recordsOfKey } from './async-lift-lifecycle-siblings.js';
import type { LiftRetentionAccess } from './async-lift-retention-access.js';
import {
  PUBLISHER_RETENTION_MODES, PUBLISHER_RETENTION_WINDOW_MS, emptyClassCounts, emptyKeptCounts, judgeFinalizedRecord,
  type PublisherRetentionJobClass, type PublisherRetentionKeepReason, type PublisherRetentionMode, type PublisherRetentionPolicy,
} from './async-lift-retention-policy.js';
import { LIFT_JOB_SUBJECT_PREFIX, LiftRetentionScanState, byWalk, exactFinishTime, planFinalizedScan, type LiftScanRow } from './async-lift-retention-scan.js';
import {
  HoldBudget, RETENTION_SKIPS, RETENTION_SWEEP_DEFAULTS, RetentionClockGuard, ageWindowMs, boundedInteger, claimBatch, errorMessage, lazyRetentionLogger, positiveFinite, sumInto,
  type RetentionLogger, type RetentionSkip,
} from './retention-sweep-core.js';

export { PUBLISHER_RETENTION_MODES, PUBLISHER_RETENTION_WINDOW_MS, type PublisherRetentionMode } from './async-lift-retention-policy.js';

export const LIFT_RETENTION_VERIFY_SOURCE = 'publisher.asyncLift.retention.verify';
export const LIFT_RETENTION_LOCKS_SOURCE = 'publisher.asyncLift.retention.walletLocks';

export const PUBLISHER_RETENTION_DEFAULTS = RETENTION_SWEEP_DEFAULTS;

export type PublisherRetentionSkip = RetentionSkip;
export type PublisherRetentionLogger = RetentionLogger;

export interface PublisherRetentionConfig {
  /** The queue's window onto its claim transaction: `publisher.retentionAccess()` of the daemon's admission instance. */
  readonly access: LiftRetentionAccess;
  /** Default `off`: a caller that leaves the mode out deletes and judges nothing. */
  readonly mode?: PublisherRetentionMode;
  /** The pause between two `runBatch()` calls the caller schedules (ms). The clock guard's tolerance is `clockGuardFactor` times it. */
  readonly intervalMs: number;
  /** Default 7 days (D-6); at least `PUBLISHER_RETENTION_DEFAULTS.minWindowMs` (24 h). */
  readonly finalizedMaxAgeMs?: number;
  /** Most candidate rows one batch judges: a positive integer of at most `PUBLISHER_RETENTION_DEFAULTS.maxBatchSize` (1000). */
  readonly batchSize?: number;
  readonly sliceSize?: number;
  readonly holdBudgetMs?: number;
  readonly rescanIntervalMs?: number;
  readonly clockGuardFactor?: number;
  /** Wall clock (ms); defaults to `Date.now`. */
  readonly now?: () => number;
  /** Monotonic clock (ms) that times the holds; defaults to `performance.now`. */
  readonly monotonicNow?: () => number;
  readonly logger?: PublisherRetentionLogger;
}

/** One judged job: what was verified under the lock (an audit trail; no payload, no lifecycle key). */
export interface PublisherRetentionJob {
  readonly jobId: string;
  readonly jobClass: PublisherRetentionJobClass;
  readonly state: string;
  readonly finalizedAt: number;
  readonly ageMs: number;
}

export interface PublisherRetentionBatchResult {
  readonly mode: PublisherRetentionMode;
  /** Set when nothing was done: mode `off`, an overlapping batch, or the clock guard. */
  readonly skipped?: PublisherRetentionSkip;
  /** Candidate rows judged by this call (<= batchSize); the rows one scan returned beyond that are read again by the next call. */
  readonly scanned: number;
  readonly scanQueries: number;
  readonly deleted: number;
  readonly deletedJobs: readonly PublisherRetentionJob[];
  /** Report mode: the jobs `delete` would remove. */
  readonly wouldDelete: number;
  readonly wouldDeleteJobs: readonly PublisherRetentionJob[];
  readonly kept: Readonly<Record<PublisherRetentionKeepReason, number>>;
  /** The scan has not reached the end of the old-enough rows yet: the next call continues the pass. False = parked at the frontier. */
  readonly hasMore: boolean;
  /** Scans whose result violated the ORDER BY / LIMIT / cursor contract (the cursor was not advanced). Zero on a conforming engine. */
  readonly anomalies: number;
  /** Holds of the claim lock this call took, the longest one, and how many ended past the budget. */
  readonly holds: number;
  readonly maxHoldMs: number;
  readonly holdBudgetExceeded: number;
  /** This call finished a pass that began at a fresh cursor (the gauge `lastCompletePass` was replaced). */
  readonly passCompleted: boolean;
  /** Set when a scan / verify / delete failed; counts above are what completed before the failure (no cursor moved). */
  readonly error?: { readonly phase: 'scan' | 'verify' | 'delete'; readonly message: string };
}

export interface PublisherRetentionPassSummary {
  readonly completedAt: number;
  readonly scanned: number;
  /** Report mode: jobs `delete` would have removed in the pass, by class. A gauge of THIS pass, not cumulative. */
  readonly wouldDelete: Readonly<Record<PublisherRetentionJobClass, number>>;
  readonly deleted: Readonly<Record<PublisherRetentionJobClass, number>>;
  readonly kept: Readonly<Record<PublisherRetentionKeepReason, number>>;
}

export interface PublisherRetentionCounters {
  readonly mode: PublisherRetentionMode;
  readonly batches: number;
  readonly skipped: Readonly<Record<PublisherRetentionSkip, number>>;
  readonly errors: Readonly<Record<'scan' | 'verify' | 'delete', number>>;
  readonly anomalies: number;
  readonly scanned: number;
  /** Cumulative since the sweep was created. */
  readonly deleted: Readonly<Record<PublisherRetentionJobClass, number>>;
  /** Cumulative judgments by reason (a row kept by a pass is counted again by the next pass). */
  readonly kept: Readonly<Record<PublisherRetentionKeepReason, number>>;
  readonly holds: number;
  readonly holdBudgetExceeded: number;
  readonly maxHoldMs: number;
  /** The slice size now in effect (it adapts to the hold budget). */
  readonly sliceSize: number;
  /** The latest COMPLETE pass, undefined until one finished. In report mode `wouldDelete` is the per-pass gauge the delete gate reads. */
  readonly lastCompletePass?: PublisherRetentionPassSummary;
}

export interface PublisherRetention {
  readonly mode: PublisherRetentionMode;
  runBatch(): Promise<PublisherRetentionBatchResult>;
  counters(): PublisherRetentionCounters;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------------------------------

interface ResolvedConfig {
  readonly mode: PublisherRetentionMode; readonly intervalMs: number; readonly policy: PublisherRetentionPolicy;
  readonly batchSize: number; readonly sliceSize: number; readonly holdBudgetMs: number; readonly rescanIntervalMs: number; readonly clockGuardFactor: number;
}

function resolveConfig(config: PublisherRetentionConfig): ResolvedConfig {
  const d = PUBLISHER_RETENTION_DEFAULTS;
  const mode = config.mode ?? 'off';
  if (!(PUBLISHER_RETENTION_MODES as readonly string[]).includes(mode)) throw new Error(`mode must be one of ${PUBLISHER_RETENTION_MODES.join(', ')}`);
  const finalizedMaxAgeMs = ageWindowMs(config.finalizedMaxAgeMs ?? PUBLISHER_RETENTION_WINDOW_MS, 'finalizedMaxAgeMs');
  const rescanIntervalMs = config.rescanIntervalMs ?? d.rescanIntervalMs;
  if (typeof rescanIntervalMs !== 'number' || Number.isNaN(rescanIntervalMs) || rescanIntervalMs <= 0) throw new Error('rescanIntervalMs must be a positive number (Infinity = never)');
  const holdBudgetMs = positiveFinite(config.holdBudgetMs ?? d.holdBudgetMs, 'holdBudgetMs');
  if (holdBudgetMs > d.maxHoldBudgetMs) throw new Error(`holdBudgetMs must be at most ${d.maxHoldBudgetMs}`);
  const clockGuardFactor = positiveFinite(config.clockGuardFactor ?? d.clockGuardFactor, 'clockGuardFactor');
  if (clockGuardFactor < 1) throw new Error('clockGuardFactor must be at least 1');
  return {
    mode, intervalMs: positiveFinite(config.intervalMs, 'intervalMs'), policy: { finalizedMaxAgeMs },
    batchSize: boundedInteger(config.batchSize ?? d.batchSize, 'batchSize', d.maxBatchSize),
    sliceSize: boundedInteger(config.sliceSize ?? d.sliceSize, 'sliceSize', d.maxSliceSize),
    holdBudgetMs, rescanIntervalMs, clockGuardFactor,
  };
}

const logger = lazyRetentionLogger('AsyncLiftRetention');

/** The payload, status, finish time and lifecycle key stored for a slice of candidate subjects (read again under the claim lock). The slice is bounded by the caller. */
export function buildLiftRetentionVerifyQuery(graph: string, subjects: readonly string[]): string {
  return `SELECT ?job ?payload ?state ?finalizedAt ?key WHERE { GRAPH <${graph}> { VALUES ?job { ${subjects.map(iri => `<${iri}>`).join(' ')} } ?job <${CONTROL_PAYLOAD}> ?payload . OPTIONAL { ?job <${CONTROL_STATUS}> ?state } OPTIONAL { ?job <${CONTROL_FINALIZED_AT}> ?finalizedAt } OPTIONAL { ?job <${CONTROL_LIFECYCLE_KEY}> ?key } } }`;
}

/** The candidates a wallet lock still names (a bound obligation), in any state of the lock. */
export function buildLiftRetentionBoundQuery(lockGraph: string, subjects: readonly string[]): string {
  return `SELECT ?job WHERE { GRAPH <${lockGraph}> { ?lock <${CONTROL_LOCKED_JOB}> ?job . VALUES ?job { ${subjects.map(iri => `<${iri}>`).join(' ')} } } }`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------------------------------------------------------------------

interface PassTally {
  /** Began at a fresh cursor and has seen no scan anomaly: only such a pass can complete (see the share sweep for why). */
  fresh: boolean; scanned: number;
  wouldDelete: Record<PublisherRetentionJobClass, number>; deleted: Record<PublisherRetentionJobClass, number>; kept: Record<PublisherRetentionKeepReason, number>;
}
const newPass = (fresh: boolean): PassTally => ({ fresh, scanned: 0, wouldDelete: emptyClassCounts(), deleted: emptyClassCounts(), kept: emptyKeptCounts() });

interface SliceRow extends LiftScanRow { readonly jobId: string }

/** What one batch has done so far; the result is built from it whenever the batch ends. */
class BatchState {
  scanned = 0; scanQueries = 0; anomalies = 0; holds = 0; maxHoldMs = 0; holdBudgetExceeded = 0;
  readonly deleted: PublisherRetentionJob[] = []; readonly wouldDelete: PublisherRetentionJob[] = [];
  readonly kept = emptyKeptCounts();
  phase: 'scan' | 'verify' | 'delete' = 'scan';
  /** A delete that threw: the job may or may not be gone. */
  indeterminate?: string;
}

/** A candidate that passed its own checks under the lock: the record the plan of its key is made from. */
interface Judged { readonly row: SliceRow; readonly job: LiftJob; readonly key: string | null }

/** A job the plan lets go, in the order to delete it, with what the batch needs to report or block on it. */
interface Doomed { readonly row: SliceRow; readonly entry: PublisherRetentionJob; readonly job: LiftJob; readonly key: string | null }

const termString = (term: string | undefined): string | undefined => { try { return parseLiteral(String(term)) as string; } catch { return undefined; } };
/**
 * The stored status and finish time are what the scan reads a row by: they agree with the payload when the scan meets the record as a finalized row of its finish time, one
 * `xsd:integer` term (a decimal or any other term of the same value is one the scan never reads, async-lift-retention-scan.ts).
 */
const indexAgrees = (states: ReadonlySet<string>, finishes: ReadonlySet<string>, finalizedAt: number | undefined): boolean =>
  states.size === 1 && termString([...states][0]) === 'finalized' && finishes.size === 1 && exactFinishTime([...finishes][0]) === finalizedAt;
/** Where the scan's walk meets a finalized record (`byWalk`): its finish time, then its subject. */
const walkPosition = (job: PersistedLiftJob): LiftScanRow => ({ iri: jobSubject(job.jobId), finalizedAt: job.timestamps.finalizedAt! });
/** Most subjects one verify read names: a key with a long history is read in several queries. */
const VERIFY_CHUNK = 100;

class PublisherRetentionImpl implements PublisherRetention {
  readonly mode: PublisherRetentionMode;
  private readonly cfg: ResolvedConfig;
  private readonly access: LiftRetentionAccess;
  private readonly scan: LiftRetentionScanState;
  private readonly clock: () => number;
  private readonly mono: () => number;
  private readonly log: PublisherRetentionLogger | undefined;
  private readonly budget: HoldBudget;
  private readonly guard: RetentionClockGuard;
  private pass = newPass(true);
  /**
   * Per lifecycle key, the MARK: the oldest record, in the key's own order (`acceptedAt`, then job id: `compareAcceptedJobs`), that this walk of the scan KEPT although the records
   * alone might let it go later: it waits for an older record that finished later, a rule that needs the job alone holds it (a wallet lock, a stored index that disagrees, a date after
   * now), an older failed sibling stands in front of it, or the key could not be read. The scan moves past a kept record, and whatever held it can pass before the walk ends (the clock
   * moves on, an operator clears the failed job, the key becomes readable): so every record of the key AFTER the mark in that order waits too, and the records of a key leave strictly
   * oldest first: what a failed or stopped sweep leaves behind is always a suffix of the key. A record before the mark is not held by it, even one accepted in the same millisecond
   * (a lower job id is older). One acceptance time and id per key the walk has kept a record of (the keys held back by a failed job are most of it). Cleared when the scan restarts.
   */
  private readonly blockedSince = new Map<string, AcceptanceOrderKey>();
  private lastCompletePass: PublisherRetentionPassSummary | undefined;
  private readonly totals = {
    batches: 0, anomalies: 0, scanned: 0, holds: 0, holdBudgetExceeded: 0, maxHoldMs: 0,
    skipped: Object.fromEntries(RETENTION_SKIPS.map(reason => [reason, 0])) as Record<PublisherRetentionSkip, number>,
    errors: { scan: 0, verify: 0, delete: 0 },
    deleted: emptyClassCounts(), kept: emptyKeptCounts(),
  };

  constructor(config: PublisherRetentionConfig) {
    this.cfg = resolveConfig(config);
    this.mode = this.cfg.mode;
    this.access = config.access;
    this.scan = new LiftRetentionScanState(this.cfg.rescanIntervalMs);
    this.clock = config.now ?? (() => Date.now());
    this.mono = config.monotonicNow ?? (() => performance.now());
    this.log = config.logger;
    this.budget = new HoldBudget(this.cfg.sliceSize, this.cfg.holdBudgetMs);
    this.guard = new RetentionClockGuard(this.cfg.intervalMs, this.cfg.clockGuardFactor);
  }

  counters(): PublisherRetentionCounters {
    const t = this.totals;
    return {
      mode: this.mode, batches: t.batches, skipped: { ...t.skipped }, errors: { ...t.errors }, anomalies: t.anomalies, scanned: t.scanned,
      deleted: { ...t.deleted }, kept: { ...t.kept }, holds: t.holds, holdBudgetExceeded: t.holdBudgetExceeded, maxHoldMs: t.maxHoldMs, sliceSize: this.budget.sliceNow,
      ...(this.lastCompletePass ? { lastCompletePass: this.lastCompletePass } : {}),
    };
  }

  async runBatch(): Promise<PublisherRetentionBatchResult> {
    if (this.mode === 'off') return this.skip('off');                                 // no store call, no lock, no clock read
    const release = claimBatch(this.access.store, this.access.graphUri);
    if (release === undefined) return this.skip('overlap');
    try {
      const now = this.clock(), mono = this.mono();
      const verdict = this.guard.verdict(now, mono);
      if (verdict) {
        this.warn(`async_lift_retention skipped=${verdict} mode=${this.mode} now=${now}`);
        return this.skip(verdict);                                               // a skipped tick is not a sweep start: it never moves the baseline
      }
      this.guard.started(now, mono);
      return await this.batch(now);
    } finally {
      release();
    }
  }

  private skip(reason: PublisherRetentionSkip): PublisherRetentionBatchResult {
    this.totals.skipped[reason] += 1;
    return this.result(new BatchState(), { skipped: reason, hasMore: reason === 'off' ? false : reason === 'overlap' ? true : this.scan.hasMore });
  }

  // ---- one batch ------------------------------------------------------------------------------------------------------------------------

  private async batch(now: number): Promise<PublisherRetentionBatchResult> {
    const b = new BatchState();
    this.totals.batches += 1;
    if (this.scan.rewindIfDue(now) === 'restart') { this.pass = newPass(true); this.blockedSince.clear(); }

    let plan;
    try {
      const planned = await planFinalizedScan({ store: this.access.store, graphUri: this.access.graphUri }, Math.floor(now - this.cfg.policy.finalizedMaxAgeMs), this.cfg.batchSize, this.scan.currentCursor());
      b.scanQueries += planned.queries;
      if (planned.anomaly) b.anomalies++;
      plan = planned.plan;
    } catch (cause) { return this.end(b, now, { phase: 'scan', message: errorMessage(cause) }); }
    b.scanned = plan.judged.length;

    let pending: SliceRow[] = [];
    for (const row of plan.judged) {
      const jobId = row.iri.startsWith(LIFT_JOB_SUBJECT_PREFIX) ? row.iri.slice(LIFT_JOB_SUBJECT_PREFIX.length) : '';
      if (isSafeJobId(jobId) && jobSubject(jobId) === row.iri) pending.push({ ...row, jobId });
      else b.kept.unreadable += 1;                                                 // never interpolate an id the job-id grammar does not allow
    }
    while (pending.length > 0) {
      const slice = pending.slice(0, this.budget.sliceNow);
      try {
        const deferred = await this.hold(slice, b, now);
        pending = [...deferred, ...pending.slice(slice.length)];
      } catch (cause) {
        if (b.phase === 'delete' && b.indeterminate !== undefined) this.warn(`async_lift_retention delete_outcome_unknown jobId=${b.indeterminate} error=${JSON.stringify(errorMessage(cause))}`);
        return this.end(b, now, { phase: b.phase, message: errorMessage(cause) });
      }
    }
    // every slice succeeded: move the cursor past the rows that were judged (a scan that broke the contract keeps its cursor)
    this.scan.commit(plan);
    return this.end(b, now);
  }

  /**
   * One hold of the claim lock: re-read the slice, judge every candidate again from the payload, read the records of each candidate's key, let the key's plan decide,
   * and (delete mode) remove the surviving jobs one at a time, oldest first within a key. Returns the rows it did not get to because the hold budget was used up;
   * they are verified again under a later hold. When the hold deleted anything the store is flushed once the claim transaction is closed.
   */
  private async hold(slice: readonly SliceRow[], b: BatchState, now: number): Promise<SliceRow[]> {
    const deferred = new Set<SliceRow>();                                           // returned in the slice's order, which is the walk's
    const entries: PublisherRetentionJob[] = [];                                    // the jobs this hold deleted (delete mode only): logged once it ends
    try {
      await this.access.runClaimTransaction(async (tx) => {
        const startedAt = this.mono();
        b.phase = 'verify';
        const judged = await this.judgeCandidates(slice, b, now);
        const { doomed, unplanned } = await this.planDeletions(judged, tx, b, now, startedAt);
        for (const j of unplanned) deferred.add(j.row);
        let fitted = unplanned.length > 0 ? slice.length - unplanned.length : undefined;   // the rows the hold settled, when it left some to the next one

        if (this.mode !== 'delete') {
          for (const d of doomed) b.wouldDelete.push(d.entry);                       // report mode: counted, never logged job by job (the pass summary carries the numbers)
        } else if (doomed.length > 0) {
          b.phase = 'delete';
          let lastOpMs = 0;
          const held = new Set<string>();                                              // keys where a record turned out changed: the records behind it wait
          for (let i = 0; i < doomed.length; i++) {
            const d = doomed[i]!;
            if (i > 0 && this.budget.wouldExceed(this.mono() - startedAt, lastOpMs)) { for (const x of doomed.slice(i)) deferred.add(x.row); fitted = entries.length; break; }
            if (d.key !== null && held.has(d.key)) { b.kept.older_sibling_pending += 1; continue; }
            const opStartedAt = this.mono();
            b.indeterminate = d.row.jobId;
            let why: PublisherRetentionKeepReason | undefined;
            // The invariant at the last line, on the record the job lock just re-read: finalized, the same finish time, old enough, not dated after now.
            const outcome = await tx.remove(d.row.jobId, current => {
              why = judgeFinalizedRecord(current, now, this.cfg.policy);
              if (why === undefined && current.timestamps.finalizedAt !== d.entry.finalizedAt) why = 'index_mismatch';
              return why === undefined;
            });
            b.indeterminate = undefined;
            lastOpMs = this.mono() - opStartedAt;
            if (outcome === 'removed') {
              b.deleted.push(d.entry); entries.push(d.entry);
              this.totals.deleted[d.entry.jobClass] += 1; this.pass.deleted[d.entry.jobClass] += 1;
            } else {
              b.kept[outcome === 'missing' ? 'vanished' : (why ?? 'not_terminal')] += 1;
              if (outcome === 'changed') { this.block(d.key, d.job); if (d.key !== null) held.add(d.key); }
            }
          }
        }
        this.noteHold(b, this.mono() - startedAt, slice.length, fitted);
      });
    } finally {
      this.logJobs(entries, now);
    }
    // Durability, outside the claim transaction: the lock is released, so a flush (a full snapshot on a file-backed store) delays no admission or claim and is not part of
    // the hold's measured time or of the budget the next delete is predicted against. A crash before it only resurrects rows a later pass deletes again.
    if (this.mode === 'delete' && entries.length > 0) await this.access.store.flush?.();
    return slice.filter(row => deferred.has(row));
  }

  /** The stored payload, status, finish time and key of `iris` (control path, inside the claim transaction), as a lookup of one column of one subject. */
  private async readStored(iris: readonly string[]): Promise<(iri: string, column: string) => Set<string>> {
    const rows = expectBindings(await this.access.store.query(buildLiftRetentionVerifyQuery(this.access.graphUri, iris), controlStoreOptions('publisher', LIFT_RETENTION_VERIFY_SOURCE)));
    return (iri, column) => new Set(rows.flatMap(row => (row['job'] === iri && row[column] !== undefined ? [row[column]!] : [])));
  }

  /** Re-read the slice under the lock and apply every rule that needs the job alone. A candidate that passes is a `Judged`; the rest are counted as kept. */
  private async judgeCandidates(slice: readonly SliceRow[], b: BatchState, now: number): Promise<Judged[]> {
    const { store, walletLockGraphUri } = this.access;
    const iris = slice.map(s => s.iri);
    const stored = await this.readStored(iris);
    const bound = new Set(expectBindings(await store.query(buildLiftRetentionBoundQuery(walletLockGraphUri, iris), controlStoreOptions('publisher', LIFT_RETENTION_LOCKS_SOURCE))).map(row => row['job']));

    const judged: Judged[] = [];
    for (const row of slice) {
      const keep = (reason: PublisherRetentionKeepReason): void => { b.kept[reason] += 1; };
      const payloads = stored(row.iri, 'payload');
      if (payloads.size === 0) { keep('vanished'); continue; }
      const decoded = payloads.size === 1 ? decodeLiftJobPayload([...payloads][0]) : undefined;
      if (decoded?.kind === 'unknown') { keep('unknown_state'); continue; }
      if (decoded?.kind !== 'canonical' || decoded.job.jobId !== row.jobId) { keep('unreadable'); continue; }
      const job = decoded.job;
      if (job.status !== 'finalized') { keep('not_terminal'); continue; }
      const key = lifecycleKeyOfJob(job);
      const keys = stored(row.iri, 'key');
      // The stored lifecycle key is not parsed and compared with the payload's here (its U+001F separators are spelled the engine's way): the key's records are read by that very
      // triple (planDeletions), so a record whose triple names another key is not among them and is kept there. A second key triple, even next to the right one, names a key whose
      // admission reads this record and refuses it, and deleting the record would change that answer (online review 4395740472). So a job with a key carries at most one key triple
      // (a legacy one none: the same read judges it), and a job without a key none at all.
      const indexed = indexAgrees(stored(row.iri, 'state'), stored(row.iri, 'finalizedAt'), job.timestamps.finalizedAt) && keyedIndexAgrees(keys, key);
      if (!indexed) { keep('index_mismatch'); this.block(key, job); continue; }
      if (bound.has(row.iri)) { keep('bound_obligation'); this.block(key, job); continue; }
      const own = judgeFinalizedRecord(job, now, this.cfg.policy);
      if (own !== undefined) { keep(own); this.block(key, job); continue; }
      judged.push({ row, job, key });
    }
    return judged;
  }

  /**
   * The key plans: for each lifecycle key among the candidates, read its records as admission does and let the plan (the deletable prefix, oldest first) decide each
   * candidate. Returns the jobs to delete in the order to delete them (key by key, oldest first within a key), and the candidates of the keys left to the next hold.
   *
   * The hold budget bounds this work too (#3563). A key's sibling read and the verification of its older records run inside the claim lock, and a key with a long history
   * brings many records. So a key after the first starts only while the budget, predicted from the key before it, allows it, and a verification that runs out of budget stops:
   * that key and every key after it wait for the next hold, which starts with them. When the first key of a hold runs out, no hold would fit it, and its candidates are kept
   * for this pass (`siblings_too_many`), with every record of the key behind them (its mark).
   */
  private async planDeletions(
    judged: readonly Judged[], tx: { siblings(key: string): Promise<PersistedLiftJob[]> }, b: BatchState, now: number, startedAt: number,
  ): Promise<{ doomed: Doomed[]; unplanned: Judged[] }> {
    const doomed: Doomed[] = [];
    const unplanned: Judged[] = [];
    const doom = (j: Judged): void => {
      const finalizedAt = j.job.timestamps.finalizedAt!;
      doomed.push({ row: j.row, job: j.job, key: j.key, entry: { jobId: j.row.jobId, jobClass: 'finalized', state: j.job.status, finalizedAt, ageMs: now - finalizedAt } });
    };
    const byKey = new Map<string | null, Judged[]>();
    for (const j of judged) byKey.set(j.key, [...(byKey.get(j.key) ?? []), j]);

    let keyStartedAt: number | undefined;                                                // when the last key this hold read began
    for (const [key, members] of byKey) {
      if (key === null) { for (const j of members) doom(j); continue; }              // no lifecycle key: no sibling can bind it
      const first = keyStartedAt === undefined;
      if (unplanned.length > 0 || (!first && this.budget.wouldExceed(this.mono() - startedAt, this.mono() - keyStartedAt!))) { unplanned.push(...members); continue; }
      keyStartedAt = this.mono();
      let siblings: PersistedLiftJob[];
      try { siblings = await tx.siblings(key); } catch (cause) {
        if (!isUndecodableSiblingError(cause)) throw cause;                               // a store failure ends the batch; an undecodable record, or two of one job id, keeps the key's candidates
        b.kept.siblings_unreadable += members.length;
        for (const j of members) this.block(key, j.job);                                // the key may be readable by the time the scan reaches its next record
        continue;
      }
      const ordered = [...members].sort((x, y) => compareAcceptedJobs(x.job, y.job));
      const refused = await this.refusedSiblings(siblings, key, ordered, startedAt);
      if (refused === undefined) {                                                      // the key's older records could not all be verified within the budget
        if (!first) { unplanned.push(...members); continue; }
        b.kept.siblings_too_many += members.length;
        for (const j of members) this.block(key, j.job);
        continue;
      }
      const plan = planKeyDeletion(siblings, key, record => (refused.has(record.jobId) ? 'index_mismatch' : judgeFinalizedRecord(record, now, this.cfg.policy)));
      const inKey = new Set(plan.order.map(record => record.jobId));
      // Records leave a key oldest first. The scan walks the rows by finish time and the rows of one finish time by subject (`byWalk`: the tie scan reads them so, and every
      // batch is judged so), which need not be the key's order. So the records of the plan that go in THIS pass are those from the oldest up to the first that the walk meets
      // no later than the one before it. A record accepted earlier but met later may be met after its successors: those met before it wait, with every record behind them (the
      // key's mark), for a later pass; it goes when the walk reaches it only if it is in such a run and before the mark. The run is a function of the stored records and the walk
      // order alone, so report and delete name the same records (#3554: comparing finish times alone split two records finished at the same instant, which delete took in one
      // pass once it had removed the older, while report, which removes nothing, kept the newer). Nothing leaves out of order.
      const inOrder = new Set<string>();
      for (let i = 0; i < plan.prefix.length && (i === 0 || byWalk(walkPosition(plan.prefix[i - 1]!), walkPosition(plan.prefix[i]!)) < 0); i++) inOrder.add(plan.prefix[i]!.jobId);
      for (const j of ordered) {
        const reason = plan.kept.get(j.row.jobId);
        if (!inKey.has(j.row.jobId)) { b.kept.index_mismatch += 1; this.block(key, j.job); continue; }   // admission cannot reach this record: its siblings cannot be judged
        if (reason !== undefined) { b.kept[reason === 'blocked' ? 'older_sibling_kept' : reason as PublisherRetentionKeepReason] += 1; this.block(key, j.job); continue; }
        if (!inOrder.has(j.row.jobId) || this.heldByMark(key, j.job)) {
          b.kept.older_sibling_pending += 1; this.block(key, j.job); continue;
        }
        doom(j);
      }
    }
    return { doomed, unplanned };
  }

  /**
   * The finalized records of `key` older than its youngest candidate (and not candidates themselves) that this sweep could not delete itself: the plan must not reach past them,
   * or a newer record would go while they stay. A record the scan met earlier and kept is in `blockedSince`, and one it would delete (in report mode, one an earlier hold counted) is
   * no obstacle. What `blockedSince` cannot know is a record the scan never meets: a pre-upgrade payload the sweep does not delete, a stored status or finish time that is missing
   * or disagrees with the payload, or a finish time stored as a term the scan does not read (not an `xsd:integer`). So the stored index of each is read and the candidate checks of
   * `judgeCandidates` are applied to it, the key triples included (a second one, which the scan meets, makes a record the sweep never deletes): one that would not pass is refused,
   * and a refused record ends the plan's prefix. The answer is a function of the stored records alone, so report and delete mode give the same one. The records are read a
   * chunk at a time, and a chunk after the first only while the hold budget, predicted from the chunk before it, allows (#3563): undefined when one was not read.
   */
  private async refusedSiblings(siblings: readonly PersistedLiftJob[], key: string, members: readonly Judged[], startedAt: number): Promise<Set<string> | undefined> {
    const refused = new Set<string>();
    const youngest = members[members.length - 1]!.job;
    const candidates = new Set(members.map(j => j.row.jobId));
    const toRead = new Map<string, PersistedLiftJob>();                                 // subject -> sibling
    for (const record of recordsOfKey(siblings, key)) {
      if (compareAcceptedJobs(record, youngest) >= 0) break;
      if (candidates.has(record.jobId)) continue;                                      // judged already, from its own payload
      if (record.status !== 'finalized') break;                                         // ends the plan's prefix by itself: no record behind it is judged, so none of them is read
      if (isSafeJobId(record.jobId)) toRead.set(jobSubject(record.jobId), record);
      else refused.add(record.jobId);                                                  // never interpolate an id the job-id grammar does not allow
    }
    const iris = [...toRead.keys()];
    let lastChunkMs = 0;
    for (let i = 0; i < iris.length; i += VERIFY_CHUNK) {
      if (i > 0 && this.budget.wouldExceed(this.mono() - startedAt, lastChunkMs)) return undefined;
      const chunk = iris.slice(i, i + VERIFY_CHUNK);
      const chunkStartedAt = this.mono();
      const stored = await this.readStored(chunk);
      lastChunkMs = this.mono() - chunkStartedAt;
      for (const iri of chunk) {
        const record = toRead.get(iri)!;
        const payloads = stored(iri, 'payload');
        const decoded = payloads.size === 1 ? decodeLiftJobPayload([...payloads][0]) : undefined;
        const reachable = decoded?.kind === 'canonical' && decoded.job.jobId === record.jobId && decoded.job.status === 'finalized'
          && indexAgrees(stored(iri, 'state'), stored(iri, 'finalizedAt'), decoded.job.timestamps.finalizedAt) && keyedIndexAgrees(stored(iri, 'key'), key);
        if (!reachable) refused.add(record.jobId);
      }
    }
    return refused;
  }

  /** Keep `job`'s place as the mark of its key when it comes before the mark there is (the mark stays the OLDEST record kept, whatever order the walk met them in). */
  private block(key: string | null, job: LiftJob): void {
    if (key === null) return;
    const mark = this.blockedSince.get(key);
    if (mark === undefined || compareAcceptedJobs(job, mark) < 0) this.blockedSince.set(key, { jobId: job.jobId, timestamps: { acceptedAt: job.timestamps.acceptedAt } });
  }

  /** `job` comes strictly after the mark of `key` in the key's order, so it waits for the record the walk kept (the record that is the mark is not held by itself). */
  private heldByMark(key: string, job: LiftJob): boolean {
    const mark = this.blockedSince.get(key);
    return mark !== undefined && compareAcceptedJobs(job, mark) > 0;
  }

  /** Time the hold and adapt the slice size. */
  private noteHold(b: BatchState, elapsedMs: number, sliceLength: number, fittedInBudget: number | undefined): void {
    b.holds += 1; this.totals.holds += 1;
    b.maxHoldMs = Math.max(b.maxHoldMs, elapsedMs); this.totals.maxHoldMs = Math.max(this.totals.maxHoldMs, elapsedMs);
    if (this.budget.exceeded(elapsedMs)) { b.holdBudgetExceeded += 1; this.totals.holdBudgetExceeded += 1; }
    this.budget.adapt(elapsedMs, sliceLength, fittedInBudget);
  }

  // ---- result, counters, log ------------------------------------------------------------------------------------------------------------

  private end(b: BatchState, now: number, error?: PublisherRetentionBatchResult['error']): PublisherRetentionBatchResult {
    this.totals.anomalies += b.anomalies;
    if (b.anomalies > 0) this.pass.fresh = false;                                    // the pass may count a re-judged row twice: it never completes, the next fresh pass replaces it
    let passCompleted = false;
    if (error) this.totals.errors[error.phase] += 1;
    else {
      // Judgments count once the batch ended cleanly: after a failure the next call judges the same rows again.
      this.totals.scanned += b.scanned; sumInto(this.totals.kept, b.kept);
      this.pass.scanned += b.scanned; sumInto(this.pass.kept, b.kept);
      for (const job of b.wouldDelete) this.pass.wouldDelete[job.jobClass] += 1;
      if (this.pass.fresh && !this.scan.hasMore) passCompleted = this.completePass(now);
    }
    return this.result(b, { ...(error ? { error } : {}), passCompleted, hasMore: this.scan.hasMore });
  }

  private completePass(now: number): boolean {
    const p = this.pass;
    this.lastCompletePass = { completedAt: now, scanned: p.scanned, wouldDelete: { ...p.wouldDelete }, deleted: { ...p.deleted }, kept: { ...p.kept } };
    this.pass = newPass(false);
    this.info(`async_lift_retention_pass mode=${this.mode} scanned=${p.scanned} wouldDelete=${JSON.stringify(p.wouldDelete)} deleted=${JSON.stringify(p.deleted)} kept=${JSON.stringify(p.kept)}`);
    return true;
  }

  private result(b: BatchState, over: { skipped?: PublisherRetentionSkip; error?: PublisherRetentionBatchResult['error']; passCompleted?: boolean; hasMore: boolean }): PublisherRetentionBatchResult {
    return {
      mode: this.mode, ...(over.skipped ? { skipped: over.skipped } : {}), scanned: b.scanned, scanQueries: b.scanQueries,
      deleted: b.deleted.length, deletedJobs: b.deleted, wouldDelete: b.wouldDelete.length, wouldDeleteJobs: b.wouldDelete,
      kept: b.kept, hasMore: over.hasMore, anomalies: b.anomalies, holds: b.holds, maxHoldMs: b.maxHoldMs, holdBudgetExceeded: b.holdBudgetExceeded,
      passCompleted: over.passCompleted ?? false, ...(over.error ? { error: over.error } : {}),
    };
  }

  /** One info line per hold that deleted jobs: the audit trail of every deletion batch (plan section 5.3). Report mode writes none: its numbers are in the pass summary line. */
  private logJobs(entries: readonly PublisherRetentionJob[], now: number): void {
    if (this.mode !== 'delete' || entries.length === 0) return;
    const classes = emptyClassCounts();
    for (const e of entries) classes[e.jobClass] += 1;
    const jobs = entries.map(e => ({ jobId: e.jobId, class: e.jobClass, finalizedAt: e.finalizedAt, ageMs: e.ageMs }));
    this.info(`async_lift_retention action=deleted mode=${this.mode} count=${entries.length} classes=${JSON.stringify(classes)} now=${now} jobs=${JSON.stringify(jobs)}`);
  }

  private info(line: string): void { try { (this.log ?? logger()).info(line); } catch { /* observation never alters the sweep */ } }
  private warn(line: string): void { try { (this.log ?? logger()).warn(line); } catch { /* observation never alters the sweep */ } }
}

/**
 * Create a publisher-queue retention sweep. The returned object is passive: the caller (P10b's timer) calls `runBatch()` once per tick and reads `counters()` for
 * the periodic line. Batches never overlap.
 */
export function createPublisherRetention(config: PublisherRetentionConfig): PublisherRetention {
  return new PublisherRetentionImpl(config);
}
