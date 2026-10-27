/**
 * Retention of terminal async-promote (share) jobs: the core (OT-RFC-73 P10a, D-6, AC7).
 *
 * The RDF promote queue never deletes a terminal job on its own: rows leave only through an explicit `clearTerminalJob`. A node that shares
 * continuously therefore accumulates eight triples per share and every full-history read grows with it. This module is the engine of an OPT-IN sweep that
 * deletes the terminal jobs the D-6 policy allows (see async-promote-retention-policy.ts for the classes and the never-delete list). It is deliberately
 * conservative: when in doubt, keep. Nothing calls it here: the mode, the timer and the config are the caller's (P10b); the default mode is `off`.
 *
 * One `runBatch()` is one tick of the sweep:
 *  1. the clock guard: the tick is skipped when the wall clock stepped back or jumped forward since the previous tick;
 *  2. one index scan per class WITHOUT the queue lock, on the background lane, reads up to `batchSize` terminal jobs that look old enough after the class's
 *     keyset cursor (async-promote-retention-scan.ts);
 *  3. the candidates are processed in SLICES of at most `sliceSize` jobs. For each slice the queue's own per-graph mutation lock (promote-control-lock.ts) is
 *     taken, the payloads and stored states are re-read on the control path and every rule of the policy is applied again to the PAYLOAD, with the queue's own
 *     admission coordinator answering the pending-admission question; in `delete` mode the surviving jobs are removed ONE SUBJECT AT A TIME (no bulk update)
 *     on the control path; the lock is released between slices so admissions and claims interleave. A hold has a time budget (default 50 ms): no further
 *     delete starts once the next one would exceed it (the rest of the slice goes back for a fresh verification in a later hold), and the slice size adapts to
 *     what fits;
 *  4. only after every slice succeeded do the cursors move past the judged rows.
 * `report` mode runs steps 1 to 3 unchanged and removes nothing: the rows it counts as `wouldDelete` are exactly the rows `delete` would remove from the same
 * snapshot. It never throws for a store failure: the result carries the phase that failed and what completed before it (no cursor moves, so the next call
 * judges the same rows again - deleted ones are gone). Throws only for invalid configuration.
 *
 * What a deletion costs a caller: `getStatus(jobId)` of a deleted job becomes `null`, a retained-job reconciliation reports `absent_or_pruned` (see
 * docs/api/share-reconciliation.md), and a client that lost every reply and retries the same selector after the window is admitted again. The journal of the
 * publisher queue is not touched, and no job of any other graph.
 *
 * The sweep must see the queue's own coordinator: pass the store object the queue was built with (the coordinator is keyed on it), or the queue's coordinator.
 *
 * Exclusion between the verify and the delete is the in-process queue lock. A delete is a plain subject-scoped removal (a guarded bulk SPARQL update would be an
 * "everything" mutation to the observed store and would move the recipient key/route fence), so a second writer PROCESS that revives a job between the two is not
 * excluded: retention belongs in the daemon's admission instance only (P10b refuses to start it elsewhere).
 */
import { controlStoreOptions, deleteByPatternWithoutCount, type TripleStore } from '@origintrail-official/dkg-storage';
import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import { PromoteAdmissionCoordinator } from './promote-admission.js';
import { withPromoteControlLock } from './promote-control-lock.js';
import { isSafeJobId } from './job-id.js';
import { DEFAULT_PROMOTE_CONTROL_GRAPH_URI, classifyJobPayload, expectBindings, jobSubject } from './async-promote-queue-utils.js';
import {
  SHARE_RETENTION_MODES, SHARE_RETENTION_WINDOW_MS, decidePromoteRetention, emptyClassCounts, emptyKeptCounts,
  type PromoteRetentionJobClass, type PromoteRetentionKeepReason, type PromoteRetentionPolicy, type ShareRetentionMode,
} from './async-promote-retention-policy.js';
import {
  JOB_SUBJECT_PREFIX, RetentionScanState, buildRetentionVerifyQuery, planScan,
  type PromoteRetentionScanClass, type ScanCandidate, type ScanContext, type ScanPlan,
} from './async-promote-retention-scan.js';

export { SHARE_RETENTION_MODES, SHARE_RETENTION_WINDOW_MS, type ShareRetentionMode } from './async-promote-retention-policy.js';

const VERIFY_SOURCE = 'publisher.asyncPromote.retention.verify';
const DELETE_SOURCE = 'publisher.asyncPromote.retention.delete';

export const SHARE_RETENTION_DEFAULTS = Object.freeze({
  /** Most candidate rows one batch judges. */
  batchSize: 100,
  /** Most jobs verified and deleted under ONE hold of the queue mutation lock (the lock is released between slices). */
  sliceSize: 10,
  /** The time one hold of the lock may take: the slice size adapts to it, and no delete starts that would take the hold past it. */
  holdBudgetMs: 50,
  /** The hard maximum of the hold budget and of the slice size. */
  maxHoldBudgetMs: 50,
  maxSliceSize: 100,
  /** Safety net: every this many ms (once a pass has reached the end) the scan restarts from the oldest row. */
  rescanIntervalMs: 3_600_000,
  /** A tick is skipped when the wall clock is more than this many intervals (plus the previous batch) past the previous tick. */
  clockGuardFactor: 3,
});

export type ShareRetentionSkip = 'off' | 'overlap' | 'clock_invalid' | 'clock_backwards' | 'clock_jump';
const SKIPS: readonly ShareRetentionSkip[] = ['off', 'overlap', 'clock_invalid', 'clock_backwards', 'clock_jump'];

export interface ShareRetentionLogger { info(message: string): void; warn(message: string): void }

export interface ShareRetentionConfig {
  /** The store object the queue was built with: its admission coordinator is the one that knows the pending admissions. */
  readonly store: TripleStore;
  /** Default `off`: a caller that leaves the mode out deletes and judges nothing. */
  readonly mode?: ShareRetentionMode;
  /** The pause between two `runBatch()` calls the caller schedules (ms). The clock guard compares the gap between ticks with it. */
  readonly intervalMs: number;
  readonly graphUri?: string;
  /** Default 7 days (D-6). */
  readonly succeededMaxAgeMs?: number;
  /** Default 7 days (D-6). `null`: the harmless failed classes are kept too. */
  readonly benignFailedMaxAgeMs?: number | null;
  readonly batchSize?: number;
  readonly sliceSize?: number;
  readonly holdBudgetMs?: number;
  readonly rescanIntervalMs?: number;
  readonly clockGuardFactor?: number;
  /** The queue's coordinator, when it is not the one of `store` and `graphUri`. */
  readonly admissions?: PromoteAdmissionCoordinator;
  /** Wall clock (ms); defaults to `Date.now`. */
  readonly now?: () => number;
  /** Monotonic clock (ms) that times the holds; defaults to `performance.now`. */
  readonly monotonicNow?: () => number;
  readonly logger?: ShareRetentionLogger;
}

/** One judged job: what was verified under the lock (an audit trail; no payload). */
export interface ShareRetentionJob {
  readonly jobId: string;
  readonly jobClass: PromoteRetentionJobClass;
  readonly state: string;
  readonly updatedAt: number;
  readonly ageMs: number;
}

export interface ShareRetentionBatchResult {
  readonly mode: ShareRetentionMode;
  /** Set when nothing was done: mode `off`, an overlapping batch, or the clock guard. */
  readonly skipped?: ShareRetentionSkip;
  /** Candidate rows judged by this call (<= batchSize); the rows one scan returned beyond that are read again by the next call. */
  readonly scanned: number;
  readonly scanQueries: number;
  readonly deleted: number;
  readonly deletedJobs: readonly ShareRetentionJob[];
  /** Report mode: the jobs `delete` would remove. */
  readonly wouldDelete: number;
  readonly wouldDeleteJobs: readonly ShareRetentionJob[];
  readonly kept: Readonly<Record<PromoteRetentionKeepReason, number>>;
  /** Some scanned class has not reached the end of the old-enough rows yet: the next call continues the pass. False = parked at the frontier. */
  readonly hasMore: boolean;
  /** Scans whose result violated the ORDER BY / LIMIT / cursor contract (the cursor of such a class was not advanced). Zero on a conforming engine. */
  readonly anomalies: number;
  /** Holds of the queue lock this call took, the longest one, and how many ended past the budget. */
  readonly holds: number;
  readonly maxHoldMs: number;
  readonly holdBudgetExceeded: number;
  /** This call finished a pass that began at a fresh cursor (the gauge `lastCompletePass` was replaced). */
  readonly passCompleted: boolean;
  /** Set when a scan / verify / delete failed; counts above are what completed before the failure (no cursor moved). */
  readonly error?: { readonly phase: 'scan' | 'verify' | 'delete'; readonly message: string };
}

export interface ShareRetentionPassSummary {
  readonly completedAt: number;
  readonly scanned: number;
  /** Report mode: jobs `delete` would have removed in the pass, by class. A gauge of THIS pass, not cumulative. */
  readonly wouldDelete: Readonly<Record<PromoteRetentionJobClass, number>>;
  readonly deleted: Readonly<Record<PromoteRetentionJobClass, number>>;
  readonly kept: Readonly<Record<PromoteRetentionKeepReason, number>>;
}

export interface ShareRetentionCounters {
  readonly mode: ShareRetentionMode;
  readonly batches: number;
  readonly skipped: Readonly<Record<ShareRetentionSkip, number>>;
  readonly errors: Readonly<Record<'scan' | 'verify' | 'delete', number>>;
  readonly anomalies: number;
  readonly scanned: number;
  /** Cumulative since the sweep was created. */
  readonly deleted: Readonly<Record<PromoteRetentionJobClass, number>>;
  /** Cumulative judgments by reason (a row kept by a pass is counted again by the next pass). */
  readonly kept: Readonly<Record<PromoteRetentionKeepReason, number>>;
  readonly holds: number;
  readonly holdBudgetExceeded: number;
  readonly maxHoldMs: number;
  /** The slice size now in effect (it adapts to the hold budget). */
  readonly sliceSize: number;
  /** The latest COMPLETE pass, undefined until one finished. In report mode `wouldDelete` is the per-pass gauge delete-gate item 1 reads. */
  readonly lastCompletePass?: ShareRetentionPassSummary;
}

export interface ShareRetention {
  readonly mode: ShareRetentionMode;
  runBatch(): Promise<ShareRetentionBatchResult>;
  counters(): ShareRetentionCounters;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------------------------------------

interface ResolvedConfig {
  readonly mode: ShareRetentionMode; readonly intervalMs: number; readonly graphUri: string; readonly policy: PromoteRetentionPolicy;
  readonly batchSize: number; readonly sliceSize: number; readonly holdBudgetMs: number; readonly rescanIntervalMs: number; readonly clockGuardFactor: number;
}

function resolveConfig(config: ShareRetentionConfig): ResolvedConfig {
  const d = SHARE_RETENTION_DEFAULTS;
  const mode = config.mode ?? 'off';
  if (!(SHARE_RETENTION_MODES as readonly string[]).includes(mode)) throw new Error(`mode must be one of ${SHARE_RETENTION_MODES.join(', ')}`);
  const positive = (value: unknown, name: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
    return value;
  };
  const integer = (value: unknown, name: string, max: number): number => {
    if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) throw new Error(`${name} must be a positive integer of at most ${max}`);
    return value as number;
  };
  const graphUri = config.graphUri ?? DEFAULT_PROMOTE_CONTROL_GRAPH_URI;
  if (typeof graphUri !== 'string' || graphUri === '' || /[<>"{}|^`\\\s]/.test(graphUri)) throw new Error('graphUri must be a bare IRI');
  const succeededMaxAgeMs = positive(config.succeededMaxAgeMs ?? SHARE_RETENTION_WINDOW_MS, 'succeededMaxAgeMs');
  const benign = config.benignFailedMaxAgeMs === undefined ? SHARE_RETENTION_WINDOW_MS : config.benignFailedMaxAgeMs;
  const rescanIntervalMs = config.rescanIntervalMs ?? d.rescanIntervalMs;
  if (typeof rescanIntervalMs !== 'number' || Number.isNaN(rescanIntervalMs) || rescanIntervalMs <= 0) throw new Error('rescanIntervalMs must be a positive number (Infinity = never)');
  const holdBudgetMs = positive(config.holdBudgetMs ?? d.holdBudgetMs, 'holdBudgetMs');
  if (holdBudgetMs > d.maxHoldBudgetMs) throw new Error(`holdBudgetMs must be at most ${d.maxHoldBudgetMs}`);
  const clockGuardFactor = positive(config.clockGuardFactor ?? d.clockGuardFactor, 'clockGuardFactor');
  if (clockGuardFactor < 1) throw new Error('clockGuardFactor must be at least 1');
  return {
    mode, intervalMs: positive(config.intervalMs, 'intervalMs'), graphUri,
    policy: benign === null ? { succeededMaxAgeMs } : { succeededMaxAgeMs, benignFailedMaxAgeMs: positive(benign, 'benignFailedMaxAgeMs') },
    batchSize: integer(config.batchSize ?? d.batchSize, 'batchSize', Number.MAX_SAFE_INTEGER),
    sliceSize: integer(config.sliceSize ?? d.sliceSize, 'sliceSize', d.maxSliceSize),
    holdBudgetMs, rescanIntervalMs, clockGuardFactor,
  };
}

let defaultLogger: ShareRetentionLogger | undefined;
function logger(): ShareRetentionLogger {
  return defaultLogger ??= (() => {
    const log = new Logger('AsyncPromoteRetention');
    return { info: (message: string) => log.info(createOperationContext('system'), message), warn: (message: string) => log.warn(createOperationContext('system'), message) };
  })();
}

const termString = (term: string | undefined): string | undefined => { try { const v: unknown = JSON.parse(String(term)); return typeof v === 'string' ? v : undefined; } catch { return undefined; } };
const message = (cause: unknown): string => String((cause as Error)?.message ?? cause).slice(0, 200);
const sum = <K extends string>(into: Record<K, number>, from: Readonly<Partial<Record<K, number>>>): void => { for (const key of Object.keys(from) as K[]) into[key] += from[key] ?? 0; };

/** Batches of one store and graph never overlap, even across two sweep objects: their cursors and the lock holds would otherwise interleave. */
const activeBatches = new WeakMap<TripleStore, Set<string>>();

interface PassTally {
  /** Began at a fresh cursor: only such a pass can complete (a parked sweep that picks up newly aged rows continues the previous pass's walk). */
  fresh: boolean; scanned: number;
  wouldDelete: Record<PromoteRetentionJobClass, number>; deleted: Record<PromoteRetentionJobClass, number>; kept: Record<PromoteRetentionKeepReason, number>;
}
const newPass = (fresh: boolean): PassTally => ({ fresh, scanned: 0, wouldDelete: emptyClassCounts(), deleted: emptyClassCounts(), kept: emptyKeptCounts() });

interface SliceRow extends ScanCandidate { readonly jobId: string }

/** What one batch has done so far; the result is built from it whenever the batch ends. */
class BatchState {
  scanned = 0; scanQueries = 0; anomalies = 0; holds = 0; maxHoldMs = 0; holdBudgetExceeded = 0;
  readonly deleted: ShareRetentionJob[] = []; readonly wouldDelete: ShareRetentionJob[] = [];
  readonly kept = emptyKeptCounts();
  phase: 'scan' | 'verify' | 'delete' = 'scan';
  /** A delete that threw: the job may or may not be gone. */
  indeterminate?: string;
}

class ShareRetentionImpl implements ShareRetention {
  readonly mode: ShareRetentionMode;
  private readonly cfg: ResolvedConfig;
  private readonly ctx: ScanContext;
  private readonly admissions: PromoteAdmissionCoordinator;
  private readonly scan: RetentionScanState;
  private readonly active: readonly PromoteRetentionScanClass[];
  private readonly clock: () => number;
  private readonly mono: () => number;
  private readonly log: ShareRetentionLogger | undefined;
  private sliceNow: number;
  private lastStart: number | undefined;
  private lastDurationMs = 0;
  private pass = newPass(true);
  private lastCompletePass: ShareRetentionPassSummary | undefined;
  private readonly totals = {
    batches: 0, anomalies: 0, scanned: 0, holds: 0, holdBudgetExceeded: 0, maxHoldMs: 0,
    skipped: Object.fromEntries(SKIPS.map(reason => [reason, 0])) as Record<ShareRetentionSkip, number>,
    errors: { scan: 0, verify: 0, delete: 0 },
    deleted: emptyClassCounts(), kept: emptyKeptCounts(),
  };

  constructor(private readonly config: ShareRetentionConfig) {
    this.cfg = resolveConfig(config);
    this.mode = this.cfg.mode;
    this.ctx = { store: config.store, graphUri: this.cfg.graphUri };
    this.admissions = config.admissions ?? PromoteAdmissionCoordinator.for(config.store, this.cfg.graphUri);
    this.active = this.cfg.policy.benignFailedMaxAgeMs === undefined ? ['succeeded'] : ['succeeded', 'failed'];
    this.scan = new RetentionScanState(this.active, this.cfg.rescanIntervalMs, this.mode === 'delete');
    this.clock = config.now ?? (() => Date.now());
    this.mono = config.monotonicNow ?? (() => performance.now());
    this.log = config.logger;
    this.sliceNow = this.cfg.sliceSize;
  }

  counters(): ShareRetentionCounters {
    const t = this.totals;
    return {
      mode: this.mode, batches: t.batches, skipped: { ...t.skipped }, errors: { ...t.errors }, anomalies: t.anomalies, scanned: t.scanned,
      deleted: { ...t.deleted }, kept: { ...t.kept }, holds: t.holds, holdBudgetExceeded: t.holdBudgetExceeded, maxHoldMs: t.maxHoldMs, sliceSize: this.sliceNow,
      ...(this.lastCompletePass ? { lastCompletePass: this.lastCompletePass } : {}),
    };
  }

  async runBatch(): Promise<ShareRetentionBatchResult> {
    if (this.mode === 'off') return this.skip('off');
    const running = activeBatches.get(this.config.store) ?? activeBatches.set(this.config.store, new Set()).get(this.config.store)!;
    if (running.has(this.cfg.graphUri)) return this.skip('overlap');
    running.add(this.cfg.graphUri);
    const startedAt = this.mono();
    try {
      const now = this.clock();
      const verdict = this.clockVerdict(now);
      if (Number.isFinite(now)) this.lastStart = now;                            // a skipped tick re-baselines the guard: the next tick is judged against this one
      if (verdict) {
        this.warn(`async_promote_retention skipped=${verdict} mode=${this.mode} now=${now}`);
        return this.skip(verdict);
      }
      return await this.batch(now);
    } finally {
      this.lastDurationMs = this.mono() - startedAt;
      running.delete(this.cfg.graphUri);
    }
  }

  // ---- clock guard ----------------------------------------------------------------------------------------------------------------------

  /**
   * The wall clock decides which jobs are old enough, so a clock that stepped back or leapt forward must not be trusted for this tick: skip when `now` is earlier
   * than the previous tick's start, or later than it by more than `clockGuardFactor` intervals (plus the time the previous batch itself took: the caller paces
   * ticks from the END of a batch).
   */
  private clockVerdict(now: number): ShareRetentionSkip | undefined {
    if (!Number.isFinite(now)) return 'clock_invalid';
    if (this.lastStart === undefined) return undefined;
    if (now < this.lastStart) return 'clock_backwards';
    if (now > this.lastStart + this.cfg.clockGuardFactor * this.cfg.intervalMs + this.lastDurationMs) return 'clock_jump';
    return undefined;
  }

  private skip(reason: ShareRetentionSkip): ShareRetentionBatchResult {
    this.totals.skipped[reason] += 1;
    return this.result(new BatchState(), { skipped: reason, hasMore: reason === 'off' ? false : reason === 'overlap' ? true : this.scan.hasMore });
  }

  // ---- one batch ------------------------------------------------------------------------------------------------------------------------

  private async batch(now: number): Promise<ShareRetentionBatchResult> {
    const b = new BatchState();
    const policy = this.cfg.policy;
    const maxAgeOf = (cls: PromoteRetentionScanClass) => (cls === 'succeeded' ? policy.succeededMaxAgeMs : policy.benignFailedMaxAgeMs!);
    this.totals.batches += 1;
    if (this.scan.rewindIfDue(now) === 'restart') this.pass = newPass(true);

    const plans: ScanPlan[] = [];
    const candidates: ScanCandidate[] = [];
    try {
      let budget = this.cfg.batchSize;
      for (const cls of this.scan.order()) {
        if (budget <= 0) break;
        const { plan, anomaly, queries } = await planScan(this.ctx, cls, Math.floor(now - maxAgeOf(cls)), budget, this.scan.cursorOf(cls));
        b.scanQueries += queries;
        plans.push(plan);
        if (anomaly) b.anomalies++;
        budget -= plan.judged.length;
        for (const row of plan.judged) candidates.push({ ...row, cls });
      }
    } catch (cause) { return this.end(b, now, { phase: 'scan', message: message(cause) }); }
    b.scanned = candidates.length;

    let pending: SliceRow[] = [];
    for (const c of candidates) {
      const jobId = c.iri.startsWith(JOB_SUBJECT_PREFIX) ? c.iri.slice(JOB_SUBJECT_PREFIX.length) : '';
      if (isSafeJobId(jobId) && jobSubject(jobId) === c.iri) pending.push({ ...c, jobId });
      else this.keep(b, c, 'unreadable', now);                                    // never interpolate an id the job-id grammar does not allow
    }
    while (pending.length > 0) {
      const slice = pending.slice(0, this.sliceNow);
      try {
        const deferred = await this.hold(slice, b, now);
        pending = [...deferred, ...pending.slice(slice.length)];
      } catch (cause) {
        if (b.phase === 'delete' && b.indeterminate !== undefined) this.warn(`async_promote_retention delete_outcome_unknown jobId=${b.indeterminate} error=${JSON.stringify(message(cause))}`);
        return this.end(b, now, { phase: b.phase, message: message(cause) });
      }
    }
    // every slice succeeded: move the cursors past the rows that were judged (a class whose scan broke the contract keeps its cursor)
    this.scan.commit(plans);
    return this.end(b, now);
  }

  private keep(b: BatchState, c: ScanCandidate, reason: PromoteRetentionKeepReason, now: number, readyAt?: number): void {
    b.kept[reason] += 1;
    this.scan.noteKept(c, reason, now, readyAt);
  }

  /**
   * One hold of the queue mutation lock: re-read the slice, judge every row again from the payload, and (delete mode) remove the surviving jobs one subject at a
   * time. Returns the rows it did not get to because the hold budget was used up; they are verified again under a later hold.
   */
  private async hold(slice: readonly SliceRow[], b: BatchState, now: number): Promise<SliceRow[]> {
    const deferred: SliceRow[] = [];
    const entries: ShareRetentionJob[] = [];                                      // logged after the hold, deleted or (report) would-delete
    try {
      await withPromoteControlLock(this.cfg.graphUri, async () => {
        const startedAt = this.mono();
        b.phase = 'verify';
        const rows = expectBindings(await this.ctx.store.query(buildRetentionVerifyQuery(this.cfg.graphUri, slice.map(s => s.iri)), controlStoreOptions('share', VERIFY_SOURCE)));
        const payloads = new Map<string, Set<string>>(), states = new Map<string, Set<string>>();
        for (const row of rows) {
          if (row['job'] === undefined) continue;
          if (row['payload'] !== undefined) (payloads.get(row['job']) ?? payloads.set(row['job'], new Set()).get(row['job'])!).add(row['payload']);
          if (row['state'] !== undefined) (states.get(row['job']) ?? states.set(row['job'], new Set()).get(row['job'])!).add(row['state']);
        }
        const doomed: Array<{ row: SliceRow; entry: ShareRetentionJob }> = [];
        for (const c of slice) {
          const payload = payloads.get(c.iri);
          if (payload === undefined) { this.keep(b, c, 'vanished', now); continue; }
          const parsed = payload.size === 1 ? classifyJobPayload([...payload][0]!) : undefined;
          if (parsed?.kind !== 'job' || parsed.job.jobId !== c.jobId || !Number.isFinite(parsed.job.updatedAt)) { this.keep(b, c, 'unreadable', now); continue; }
          const stored = states.get(c.iri);
          if (stored === undefined || stored.size !== 1 || termString([...stored][0]) !== parsed.job.state) { this.keep(b, c, 'index_mismatch', now); continue; }
          let decision;
          try { decision = decidePromoteRetention(parsed.job, now, this.cfg.policy, id => this.admissions.hasPendingJob(id)); }
          catch { this.keep(b, c, 'unreadable', now); continue; }
          if (!decision.delete) {
            const ageable = decision.reason === 'too_recent' || decision.reason === 'future_dated';
            this.keep(b, c, decision.reason, now, ageable ? parsed.job.updatedAt + (c.cls === 'succeeded' ? this.cfg.policy.succeededMaxAgeMs : this.cfg.policy.benignFailedMaxAgeMs!) : undefined);
            continue;
          }
          doomed.push({ row: c, entry: { jobId: c.jobId, jobClass: decision.jobClass, state: parsed.job.state, updatedAt: parsed.job.updatedAt, ageMs: now - parsed.job.updatedAt } });
        }

        if (this.mode !== 'delete') {
          for (const d of doomed) { b.wouldDelete.push(d.entry); entries.push(d.entry); }
        } else if (doomed.length > 0) {
          b.phase = 'delete';
          let lastOpMs = 0;
          for (let i = 0; i < doomed.length; i++) {
            const d = doomed[i]!;
            if (i > 0 && (this.mono() - startedAt) + lastOpMs > this.cfg.holdBudgetMs) { deferred.push(...doomed.slice(i).map(x => x.row)); break; }
            if (!(d.entry.updatedAt <= now)) { this.keep(b, d.row, 'future_dated', now); continue; }   // the invariant, once more at the last line: never a row dated after now
            const opStartedAt = this.mono();
            this.admissions.invalidate(d.row.jobId);
            b.indeterminate = d.row.jobId;
            await deleteByPatternWithoutCount(this.ctx.store, { subject: jobSubject(d.row.jobId), graph: this.cfg.graphUri }, controlStoreOptions('share', DELETE_SOURCE));
            b.indeterminate = undefined;
            lastOpMs = this.mono() - opStartedAt;
            b.deleted.push(d.entry); entries.push(d.entry);
            this.totals.deleted[d.entry.jobClass] += 1; this.pass.deleted[d.entry.jobClass] += 1;
          }
          if (entries.length > 0) await this.ctx.store.flush?.();
        }
        this.noteHold(b, this.mono() - startedAt, slice.length, deferred.length > 0 ? entries.length : undefined);
      });
    } finally {
      this.logJobs(entries, now);
    }
    return deferred;
  }

  /** Time the hold and adapt the slice size: halve after a hold past the budget, fit the budget after a deferral, creep back up while holds are cheap. */
  private noteHold(b: BatchState, elapsedMs: number, sliceLength: number, fittedInBudget: number | undefined): void {
    b.holds += 1; this.totals.holds += 1;
    b.maxHoldMs = Math.max(b.maxHoldMs, elapsedMs); this.totals.maxHoldMs = Math.max(this.totals.maxHoldMs, elapsedMs);
    if (elapsedMs > this.cfg.holdBudgetMs) { b.holdBudgetExceeded += 1; this.totals.holdBudgetExceeded += 1; }
    if (fittedInBudget !== undefined) this.sliceNow = Math.max(1, Math.min(this.sliceNow, fittedInBudget));
    else if (elapsedMs > this.cfg.holdBudgetMs) this.sliceNow = Math.max(1, Math.floor(this.sliceNow / 2));
    else if (elapsedMs <= this.cfg.holdBudgetMs / 2 && sliceLength >= this.sliceNow && this.sliceNow < this.cfg.sliceSize) this.sliceNow += 1;
  }

  // ---- result, counters, log ------------------------------------------------------------------------------------------------------------

  private end(b: BatchState, now: number, error?: ShareRetentionBatchResult['error']): ShareRetentionBatchResult {
    this.totals.anomalies += b.anomalies;
    let passCompleted = false;
    if (error) this.totals.errors[error.phase] += 1;
    else {
      // Judgments count once the batch ended cleanly: after a failure the next call judges the same rows again.
      this.totals.scanned += b.scanned; sum(this.totals.kept, b.kept);
      this.pass.scanned += b.scanned; sum(this.pass.kept, b.kept);
      for (const job of b.wouldDelete) this.pass.wouldDelete[job.jobClass] += 1;
      if (this.pass.fresh && !this.scan.hasMore) passCompleted = this.completePass(now);
    }
    return this.result(b, { ...(error ? { error } : {}), passCompleted, hasMore: this.scan.hasMore });
  }

  private completePass(now: number): boolean {
    const p = this.pass;
    this.lastCompletePass = { completedAt: now, scanned: p.scanned, wouldDelete: { ...p.wouldDelete }, deleted: { ...p.deleted }, kept: { ...p.kept } };
    this.pass = newPass(false);
    this.info(`async_promote_retention_pass mode=${this.mode} scanned=${p.scanned} wouldDelete=${JSON.stringify(p.wouldDelete)} deleted=${JSON.stringify(p.deleted)} kept=${JSON.stringify(p.kept)}`);
    return true;
  }

  private result(b: BatchState, over: { skipped?: ShareRetentionSkip; error?: ShareRetentionBatchResult['error']; passCompleted?: boolean; hasMore: boolean }): ShareRetentionBatchResult {
    return {
      mode: this.mode, ...(over.skipped ? { skipped: over.skipped } : {}), scanned: b.scanned, scanQueries: b.scanQueries,
      deleted: b.deleted.length, deletedJobs: b.deleted, wouldDelete: b.wouldDelete.length, wouldDeleteJobs: b.wouldDelete,
      kept: b.kept, hasMore: over.hasMore, anomalies: b.anomalies, holds: b.holds, maxHoldMs: b.maxHoldMs, holdBudgetExceeded: b.holdBudgetExceeded,
      passCompleted: over.passCompleted ?? false, ...(over.error ? { error: over.error } : {}),
    };
  }

  /** One info line per hold that deleted (or, in report mode, would delete) jobs: the audit trail of every batch. */
  private logJobs(entries: readonly ShareRetentionJob[], now: number): void {
    if (entries.length === 0) return;
    const classes = emptyClassCounts();
    for (const e of entries) classes[e.jobClass] += 1;
    const jobs = entries.map(e => ({ jobId: e.jobId, class: e.jobClass, updatedAt: e.updatedAt, ageMs: e.ageMs }));
    this.info(`async_promote_retention action=${this.mode === 'delete' ? 'deleted' : 'would_delete'} mode=${this.mode} count=${entries.length} classes=${JSON.stringify(classes)} now=${now} jobs=${JSON.stringify(jobs)}`);
  }

  private info(line: string): void { try { (this.log ?? logger()).info(line); } catch { /* observation never alters the sweep */ } }
  private warn(line: string): void { try { (this.log ?? logger()).warn(line); } catch { /* observation never alters the sweep */ } }
}

/**
 * Create a share-queue retention sweep. The returned object is passive: the caller (P10b's timer) calls `runBatch()` once per tick and reads `counters()` for
 * the periodic line. Batches never overlap.
 */
export function createShareRetention(config: ShareRetentionConfig): ShareRetention {
  return new ShareRetentionImpl(config);
}
