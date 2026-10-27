/**
 * The candidate scan of publisher retention: query shapes, the keyset cursor and the per-sweep scan state (OT-RFC-73 P11; the share sweep's scan,
 * async-promote-retention-scan.ts, is the model).
 *
 * The candidates of a batch come from a KEYSET CURSOR over the stored `finalizedAt` index triple of the finalized jobs: each scan reads the finalized rows AFTER the
 * cursor, oldest first (`ORDER BY ?finalizedAt`), at most `batchSize` of them per call, judges them, and moves the cursor past every row it judged, whatever
 * the verdict. A row that cannot be deleted (a failed sibling stands in front of it, it is unreadable, a wallet lock names it, ...) is therefore looked at ONCE per
 * pass instead of in front of every later batch, so the number of such rows is irrelevant: a pass over M old rows takes about ceil(M / batchSize) calls, every
 * deletable row is reached within it, and nothing is remembered per row (the state is a handful of numbers, whatever M is). When the scan reaches the end of the
 * old-enough region the cursor PARKS there: later calls only read the rows that have become old enough since (a range that is empty most of the time). The
 * cursor is rewound only by the safety net: every `rescanIntervalMs`, once a pass has reached its end, the scan restarts from the oldest row and a new pass
 * begins. That restart is also what revisits a row kept for a reason that can pass (a wallet lock that was released, a failed sibling an operator cleared, an
 * older sibling that came later in the pass). Many rows with ONE `finalizedAt` are walked in key order through a second cursor component (`tie`), so even a group
 * larger than a batch is covered. The scan relies on the engine honouring ORDER BY / LIMIT; the result is checked (sorted, after the cursor, within the cutoff)
 * and a violation is reported in `anomalies` and never advances the cursor.
 *
 * The scan runs outside the claim lock, on the background lane (OT-RFC-73 §5.1 tagging table: it is not queue control work). It reads only the two stored
 * index triples; the payload is judged later, under the lock.
 */
import type { QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import { CONTROL_FINALIZED_AT, CONTROL_STATUS, jobSubject, literal } from './async-lift-control-plane.js';
import { expectBindings } from './async-lift-publisher-utils.js';

export const LIFT_RETENTION_SCAN_SOURCE = 'publisher.asyncLift.retention.scan';
const SCAN_OPTIONS: QueryOptions = { source: LIFT_RETENTION_SCAN_SOURCE, priority: 'background' };

export const LIFT_JOB_SUBJECT_PREFIX = jobSubject('');

/**
 * Where the scan continues. Every finalized row older than `after` has been judged. `tie` = the scan is inside a group of more rows than one batch that share
 * ONE `finalizedAt`: they are walked in key order, `afterKey` is the last one judged.
 */
export interface LiftRetentionScanCursor {
  readonly after?: number;
  readonly tie?: { readonly finalizedAt: number; readonly afterKey?: string };
}

const num = (n: number): string => (Number.isFinite(n) ? String(n) : '0');

/**
 * Candidate scan: the rows whose stored `status` is finalized and whose stored `finalizedAt` lies after the cursor and not after `cutoff`, oldest first. It asks for
 * ONE row more than `limit`, so "fewer than limit + 1 rows" means "the end of the old-enough region was reached". The status is the constant object of the
 * pattern, not a FILTER.
 */
export function buildLiftRetentionScanQuery(graph: string, cutoff: number, limit: number, cursor: LiftRetentionScanCursor = {}): string {
  const lower = cursor.after === undefined ? '' : ` FILTER (?finalizedAt > ${num(cursor.after)})`;
  return `SELECT ?job ?finalizedAt WHERE { GRAPH <${graph}> { ?job <${CONTROL_STATUS}> ${literal('finalized')} ; <${CONTROL_FINALIZED_AT}> ?finalizedAt . FILTER (?finalizedAt <= ${num(cutoff)})${lower} } } ORDER BY ?finalizedAt LIMIT ${limit + 1}`;
}

/** The finalized rows that share exactly one `finalizedAt`, in key order after `afterKey` (only used inside a group larger than one batch). */
export function buildLiftRetentionTieQuery(graph: string, finalizedAt: number, limit: number, afterKey?: string): string {
  const after = afterKey === undefined ? '' : ` FILTER (STR(?job) > ${literal(afterKey)})`;
  return `SELECT ?job ?finalizedAt WHERE { GRAPH <${graph}> { ?job <${CONTROL_STATUS}> ${literal('finalized')} ; <${CONTROL_FINALIZED_AT}> ?finalizedAt . FILTER (?finalizedAt = ${num(finalizedAt)})${after} } } ORDER BY STR(?job) LIMIT ${limit + 1}`;
}

export interface LiftScanRow { readonly iri: string; readonly finalizedAt: number }
export interface LiftScanPlan {
  /** Rows this call judges (<= the limit it was given). */
  readonly judged: readonly LiftScanRow[];
  /** Cursor after the judged rows; undefined = the scan result violated the contract, keep the old one. */
  readonly next: LiftRetentionScanCursor | undefined;
  /** The end of the old-enough region was reached (only a range scan can say so). */
  readonly caughtUp: boolean;
}

const termNumber = (term: string | undefined): number => { const m = /^"?([^"^]*)"?(?:\^\^<[^>]*>)?$/.exec(String(term ?? '')); return m && m[1] !== '' ? Number(m[1]) : Number.NaN; };
const byIri = (a: LiftScanRow, b: LiftScanRow) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0);

function parseScanRows(bindings: ReadonlyArray<Record<string, string>>): { rows: LiftScanRow[]; clean: boolean } {
  const rows: LiftScanRow[] = [];
  for (const b of bindings) { const finalizedAt = termNumber(b['finalizedAt']); if (typeof b['job'] === 'string' && Number.isFinite(finalizedAt)) rows.push({ iri: b['job'], finalizedAt }); }
  return { rows, clean: rows.length === bindings.length };
}

export interface LiftScanContext { readonly store: TripleStore; readonly graphUri: string }

/**
 * One scan: which rows to judge now, where the cursor goes afterwards, and whether the end of the region was reached. Pure with respect to the state (the caller
 * commits `next` after the rows were judged). `limit` is the budget of this call. Issues one query, or two in the call that first meets a group of more rows than
 * one batch sharing one `finalizedAt` (the range scan finds the group, the key-ordered tie scan starts walking it at once).
 */
export async function planFinalizedScan(ctx: LiftScanContext, cutoff: number, limit: number, cursor: LiftRetentionScanCursor): Promise<{ plan: LiftScanPlan; anomaly: boolean; queries: number }> {
  const keepCursor = (judged: readonly LiftScanRow[]) => ({ plan: { judged, next: undefined, caughtUp: false }, anomaly: true, queries: 1 });
  if (cursor.tie) {                                                                    // inside a group of more than one batch sharing one finalizedAt: key order
    const { finalizedAt, afterKey } = cursor.tie;
    const { rows, clean } = parseScanRows(expectBindings(await ctx.store.query(buildLiftRetentionTieQuery(ctx.graphUri, finalizedAt, limit, afterKey), SCAN_OPTIONS)));
    const ordered = clean && rows.length <= limit + 1 && rows.every((r, i) => r.finalizedAt === finalizedAt && (afterKey === undefined || r.iri > afterKey) && (i === 0 || rows[i - 1]!.iri < r.iri));
    if (!ordered) return keepCursor([...rows].sort(byIri).slice(0, limit));
    const judged = rows.slice(0, limit);
    return { plan: { judged, next: rows.length <= limit ? { after: finalizedAt } : { ...cursor, tie: { finalizedAt, afterKey: judged[judged.length - 1]!.iri } }, caughtUp: false }, anomaly: false, queries: 1 };
  }
  const { rows, clean } = parseScanRows(expectBindings(await ctx.store.query(buildLiftRetentionScanQuery(ctx.graphUri, cutoff, limit, cursor), SCAN_OPTIONS)));
  const afterOk = (t: number) => cursor.after === undefined || t > cursor.after;
  const ordered = clean && rows.length <= limit + 1 && rows.every((r, i) => afterOk(r.finalizedAt) && r.finalizedAt <= cutoff && (i === 0 || rows[i - 1]!.finalizedAt <= r.finalizedAt));
  if (!ordered) return keepCursor([...rows].sort((a, b) => a.finalizedAt - b.finalizedAt).slice(0, limit));
  if (rows.length <= limit) {                                                          // the end of the old-enough region: everything left is judged now
    return { plan: { judged: rows, next: rows.length ? { after: rows[rows.length - 1]!.finalizedAt } : cursor, caughtUp: true }, anomaly: false, queries: 1 };
  }
  // limit + 1 rows came back: the last one may belong to a group that continues beyond the result, so judge only what is strictly older than it
  const last = rows[limit]!.finalizedAt;
  const older = rows.filter(r => r.finalizedAt < last);
  if (older.length > 0) return { plan: { judged: older, next: { after: older[older.length - 1]!.finalizedAt }, caughtUp: false }, anomaly: false, queries: 1 };
  const walk = await planFinalizedScan(ctx, cutoff, limit, { ...cursor, tie: { finalizedAt: last } });   // one group larger than a batch: walk it by key, starting now
  return { ...walk, queries: walk.queries + 1 };
}

/** Per-sweep scan state: O(1), whatever the number of rows. */
export class LiftRetentionScanState {
  private cursor: LiftRetentionScanCursor = {};
  private caughtUpNow = false;
  private rescanAt: number | undefined;

  /** @param rescanIntervalMs safety net: every this many ms (once a pass has reached the end) the scan restarts from the oldest row */
  constructor(private readonly rescanIntervalMs: number) {}

  currentCursor(): LiftRetentionScanCursor { return this.cursor; }

  /** The scan has not reached the end of the old-enough rows yet. */
  get hasMore(): boolean { return !this.caughtUpNow; }

  /** Restart from the oldest row when the safety interval has elapsed and the pass reached its end. Returns `'restart'` when a new pass begins. */
  rewindIfDue(now: number): 'restart' | undefined {
    this.rescanAt ??= now + this.rescanIntervalMs;
    if (now < this.rescanAt || this.hasMore) return undefined;
    this.cursor = {};
    this.caughtUpNow = false;
    this.rescanAt = now + this.rescanIntervalMs;
    return 'restart';
  }

  /** Every slice succeeded: move the cursor past the rows that were judged (a scan that broke the contract keeps its cursor). */
  commit(plan: LiftScanPlan): void {
    if (plan.next) { this.cursor = plan.next; this.caughtUpNow = plan.caughtUp; } else this.caughtUpNow = false;
  }
}
