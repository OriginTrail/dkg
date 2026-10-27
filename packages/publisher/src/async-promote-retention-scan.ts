/**
 * The candidate scan of share-queue retention: query shapes, the keyset cursor, and the per-sweep scan state.
 *
 * SCAN PROGRESS (why rows that cannot be deleted do not starve the rows that can). The candidates of a batch come from a KEYSET CURSOR over the stored `updatedAt`
 * index triple, one cursor per scanned class (`succeeded`, and `failed` when the benign window is on): each scan reads the CANDIDATE rows of its class (next
 * section) AFTER the cursor, oldest first (`ORDER BY ?updatedAt`), at most `batchSize` of them per call (the two classes share that budget), judges them, and
 * moves the cursor past every row it judged - whatever the verdict. A row that cannot be deleted (fatal / retained `failed`, unreadable, unknown state, newer
 * format, bound obligation, orphan index row, ...) is therefore looked at ONCE per pass instead of in front of every later batch. How many such rows there are
 * decides only how many calls a pass takes - about ceil(M / batchSize) for M candidate rows, a group sharing one `updatedAt` that straddles a batch boundary
 * being judged in the next call - and every deletable candidate is reached within it, provided the engine conforms (limit 2). Nothing is remembered per row: the
 * state is a handful of numbers per class, whatever M is. When a scan reaches the end of the old-enough region the cursor PARKS there: later calls only read the
 * rows that have become old enough since (a range that is empty most of the time), they do not walk the undeletable rows again. A class is re-walked from a
 * rewound position only (a) from the oldest row kept for a TRANSIENT reason (an in-process pending admission, a payload younger than its index triple), once
 * the earliest moment it can change has passed (delete mode only: a report pass never judges a row twice, so its would-delete tally needs no de-duplication),
 * and (b) from the start every `rescanIntervalMs` (default one hour) as a safety net for rows written behind the cursor (back-dated clocks, restores) - that
 * restart begins a new pass. Many rows with ONE `updatedAt` are walked in key order (`ORDER BY STR(?job)`, the subject IRI) through a second cursor component
 * (`tie`), so even a group larger than a batch is covered.
 *
 * CANDIDATES. A subject is read only if the query itself says all of the following (the range query and the tie query carry the same subject and timestamp filters, so they
 * select the same rows; the tie query has no cutoff of its own, it walks one `updatedAt` value that a range scan found at or below the cutoff, and a row's age is checked
 * again under the lock before anything is deleted):
 *  - it is an IRI under the queue's job prefix (`isIRI`, `STRSTARTS`). A blank node has no `STR`, so `ORDER BY STR(?job)` leaves its rows in engine order and the
 *    key check of the tie walk rejects them: an anomaly on every call, the class never advances. An IRI outside the prefix is no job and could only be kept; an
 *    ASCII one was harmless, but one that mixes astral and high BMP characters stalls the tie walk in the same way (limit 3);
 *  - its stored `state` is the scanned class;
 *  - its `updatedAt` is an `xsd:integer` term in [0, cutoff]. The cursor holds a JS number and the engine compares terms exactly, so a term a double cannot represent
 *    reads back as a number the engine does not consider equal to it: `"100.0000000000000001"^^xsd:decimal` reads as 100, the tie walk at 100 does not return it (it
 *    is not equal to 100) and the range scan `> 100` does (it is greater), so the cursor would never leave it. An integer in that range is exact in a double, so
 *    the number the cursor holds IS the term (the queue writes nothing else).
 * A subject that is none of these (a blank node, an IRI elsewhere, a decimal, a double, a plain literal, a negative number, an integer after the cutoff) is not a
 * candidate: it is never read, judged, counted or deleted, so it is kept, and it stays in the graph until something else removes it.
 *
 * REPEATED ROWS. One subject can still come back as SEVERAL rows: an engine that keeps two integer lexical forms of one value (`"100"`, `"0100"`) apart answers it
 * once per term, and both match. That is a conforming answer, not a reordering: the rows of a subject are collapsed to one judged row, a window of limit + 1 ROWS
 * counts as full however few subjects the repeats left in it, and the walk goes on after the last subject judged, so repeats cost calls and never stall.
 *
 * DOCUMENTED LIMITS (each fails closed: the scan keeps what it cannot read, and no row is deleted on the strength of a bad answer).
 *  1. A subject that is not a candidate (above) is never reclaimed by this sweep.
 *  2. The scan relies on the engine honouring ORDER BY, LIMIT and FILTER. The result is checked (sorted, after the cursor, within the cutoff, at most limit + 1 rows)
 *     and a violation is counted in `anomalies` and never moves a cursor: the call still deletes the rows it judged (each is verified under the lock first), the
 *     pass that met it is never reported complete (its tally may count a re-judged row twice), and a batch may starve exactly like an unordered scan. It is a
 *     tripwire for a non-conforming engine, not a recovery.
 *  3. The key check of the tie walk compares ids as JavaScript strings, that is by UTF-16 code unit. An engine that orders by code point (Oxigraph does) answers in
 *     another order exactly when two ids first differ at a supplementary-plane character against a BMP character at or above U+E000. The queue's ids are ASCII
 *     (`isSafeJobId`), so only a foreign writer that stores such an id under the job prefix can cause it; the result is limit 2's: an anomaly on every call that
 *     meets the pair, and the class does not advance past it. (Out-of-prefix IRIs are not read, so they cannot cause it.)
 *  4. A subject whose index holds two DISTINCT integer `updatedAt` values (the queue never writes that) is a candidate at each of them: report mode judges it at
 *     both, delete mode removes it at the first.
 *
 * The scan runs outside the queue lock, on the background lane (OT-RFC-73 §5.1 tagging table: it is not queue control work). It reads only the two stored
 * index triples; the payload is judged later, under the lock.
 */
import type { QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import { PROMOTE_PAYLOAD, PROMOTE_STATE, PROMOTE_UPDATED_AT, XSD_INTEGER, expectBindings, jobSubject, literal } from './async-promote-queue-utils.js';
import type { PromoteRetentionKeepReason } from './async-promote-retention-policy.js';
import { PERMANENT_KEEP_REASONS } from './async-promote-retention-policy.js';

export const RETENTION_SCAN_SOURCE = 'publisher.asyncPromote.retention.scan';
const SCAN_OPTIONS: QueryOptions = { source: RETENTION_SCAN_SOURCE, priority: 'background' };

/** How long a row kept for a pending (uncertain) admission waits before the cursor may be rewound to it. */
const PENDING_RETRY_MS = 5_000;

export type PromoteRetentionScanClass = 'succeeded' | 'failed';

/**
 * Where the scan of one class continues. Every row of the class older than `after` has been judged, and so have the rows AT `after` unless `inclusive` (a rewind
 * target). `tie` = the scan is inside a group of more rows than one batch that share ONE `updatedAt`: they are walked in key order, `afterKey` is the last one
 * judged.
 */
export interface PromoteRetentionScanCursor {
  readonly after?: number;
  readonly inclusive?: boolean;
  readonly tie?: { readonly updatedAt: number; readonly afterKey?: string };
}

const num = (n: number): string => (Number.isFinite(n) ? String(n) : '0');
export const JOB_SUBJECT_PREFIX = jobSubject('');
/** The terms a scan may read: exact integers, which a JS number holds without loss (see the module doc). Both scan queries carry it, so they select the same rows. */
const EXACT_TIMESTAMP = `FILTER (DATATYPE(?updatedAt) = <${XSD_INTEGER}> && ?updatedAt >= 0)`;
/**
 * The subjects a scan may read: IRIs under the queue's job prefix. A blank node has no `STR`, so `ORDER BY STR(?job)` leaves its rows in engine order and the key check of
 * the tie walk rejects them (an anomaly on every call, the class never advances); an IRI outside the prefix is no job and can only be kept, and one that mixes astral and
 * high BMP characters is ordered differently by an engine (code points) and by the key check (UTF-16) with the same effect. Neither is a candidate, so neither is read.
 */
const JOB_SUBJECT_ONLY = `FILTER (isIRI(?job)) FILTER (STRSTARTS(STR(?job), ${literal(JOB_SUBJECT_PREFIX)}))`;

/**
 * Candidate scan of one class: the rows whose stored `state` is the class and whose stored `updatedAt` lies after the cursor and not after `cutoff`, oldest first.
 * It reads only the two stored index triples (the payload is judged later) and asks for ONE row more than `limit`, so "fewer than limit + 1 rows" means "the end of the
 * old-enough region was reached". The sort key is the numeric `updatedAt`, so no term has to be materialised to order the rows.
 */
export function buildRetentionScanQuery(graph: string, scanClass: PromoteRetentionScanClass, cutoff: number, limit: number, cursor: PromoteRetentionScanCursor = {}): string {
  const lower = cursor.after === undefined ? '' : ` FILTER (?updatedAt ${cursor.inclusive ? '>=' : '>'} ${num(cursor.after)})`;
  return `SELECT ?job ?updatedAt WHERE { GRAPH <${graph}> { ?job <${PROMOTE_STATE}> ${literal(scanClass)} ; <${PROMOTE_UPDATED_AT}> ?updatedAt . ${EXACT_TIMESTAMP} ${JOB_SUBJECT_ONLY} FILTER (?updatedAt <= ${num(cutoff)})${lower} } } ORDER BY ?updatedAt LIMIT ${limit + 1}`;
}

/** The rows of one class that share exactly one `updatedAt`, in key order after `afterKey` (only used inside a group larger than one batch). */
export function buildRetentionTieQuery(graph: string, scanClass: PromoteRetentionScanClass, updatedAt: number, limit: number, afterKey?: string): string {
  const after = afterKey === undefined ? '' : ` FILTER (STR(?job) > ${literal(afterKey)})`;
  return `SELECT ?job ?updatedAt WHERE { GRAPH <${graph}> { ?job <${PROMOTE_STATE}> ${literal(scanClass)} ; <${PROMOTE_UPDATED_AT}> ?updatedAt . ${EXACT_TIMESTAMP} ${JOB_SUBJECT_ONLY} FILTER (?updatedAt = ${num(updatedAt)})${after} } } ORDER BY STR(?job) LIMIT ${limit + 1}`;
}

/** Payload and stored state of a slice of candidate subjects (read again under the lock). The slice is bounded by the caller. */
export function buildRetentionVerifyQuery(graph: string, subjects: readonly string[]): string {
  return `SELECT ?job ?payload ?state WHERE { GRAPH <${graph}> { VALUES ?job { ${subjects.map(iri => `<${iri}>`).join(' ')} } ?job <${PROMOTE_PAYLOAD}> ?payload . OPTIONAL { ?job <${PROMOTE_STATE}> ?state } } }`;
}

export interface ScanRow { readonly iri: string; readonly updatedAt: number }
export interface ScanCandidate extends ScanRow { readonly cls: PromoteRetentionScanClass }
export interface ScanPlan {
  readonly cls: PromoteRetentionScanClass;
  /** Rows this call judges: one per subject, at most the limit it was given. */
  readonly judged: readonly ScanRow[];
  /** Cursor after the judged rows; undefined = the scan result violated the contract, keep the old one. */
  readonly next: PromoteRetentionScanCursor | undefined;
  /** The end of the old-enough region was reached (only a range scan can say so). */
  readonly caughtUp: boolean;
}

const termNumber = (term: string | undefined): number => { const m = /^"?([^"^]*)"?(?:\^\^<[^>]*>)?$/.exec(String(term ?? '')); return m && m[1] !== '' ? Number(m[1]) : Number.NaN; };
const byIri = (a: ScanRow, b: ScanRow) => (a.iri < b.iri ? -1 : a.iri > b.iri ? 1 : 0);
/** One row per subject, the first of an ordered answer (the oldest): a subject whose index holds equal-comparing terms comes back once per term. */
const distinctRows = (rows: readonly ScanRow[]): ScanRow[] => { const seen = new Set<string>(); return rows.filter(r => (seen.has(r.iri) ? false : (seen.add(r.iri), true))); };

function parseScanRows(bindings: ReadonlyArray<Record<string, string>>): { rows: ScanRow[]; clean: boolean } {
  const rows: ScanRow[] = [];
  for (const b of bindings) { const updatedAt = termNumber(b['updatedAt']); if (typeof b['job'] === 'string' && Number.isFinite(updatedAt)) rows.push({ iri: b['job'], updatedAt }); }
  return { rows, clean: rows.length === bindings.length };
}

export interface ScanContext { readonly store: TripleStore; readonly graphUri: string }

/**
 * One scan of one class: which rows to judge now, where the cursor goes afterwards, and whether the end of the region was reached. Pure with respect to the
 * state (the caller commits `next` after the rows were judged). `limit` is the budget left in this call. Issues one query, or two in the call that first meets
 * a group of more rows than one batch sharing one `updatedAt` (the range scan finds the group, the key-ordered tie scan starts walking it at once).
 */
export async function planScan(ctx: ScanContext, cls: PromoteRetentionScanClass, cutoff: number, limit: number, cursor: PromoteRetentionScanCursor): Promise<{ plan: ScanPlan; anomaly: boolean; queries: number }> {
  const keepCursor = (judged: readonly ScanRow[]) => ({ plan: { cls, judged, next: undefined, caughtUp: false }, anomaly: true, queries: 1 });
  if (cursor.tie) {                                                                    // inside a group of more than one batch sharing one updatedAt: key order
    const { updatedAt, afterKey } = cursor.tie;
    const { rows, clean } = parseScanRows(expectBindings(await ctx.store.query(buildRetentionTieQuery(ctx.graphUri, cls, updatedAt, limit, afterKey), SCAN_OPTIONS)));
    const ordered = clean && rows.length <= limit + 1 && rows.every((r, i) => r.updatedAt === updatedAt && (afterKey === undefined || r.iri > afterKey) && (i === 0 || rows[i - 1]!.iri <= r.iri));   // <=: a subject's own rows are adjacent
    if (!ordered) return keepCursor(distinctRows([...rows].sort(byIri)).slice(0, limit));
    const judged = distinctRows(rows).slice(0, limit);
    // limit + 1 rows = a full window, which may hide more subjects even when repeats left fewer than limit + 1 of them: continue after the last subject judged
    return { plan: { cls, judged, next: rows.length <= limit ? { after: updatedAt } : { ...cursor, tie: { updatedAt, afterKey: judged[judged.length - 1]!.iri } }, caughtUp: false }, anomaly: false, queries: 1 };
  }
  const { rows, clean } = parseScanRows(expectBindings(await ctx.store.query(buildRetentionScanQuery(ctx.graphUri, cls, cutoff, limit, cursor), SCAN_OPTIONS)));
  const afterOk = (u: number) => cursor.after === undefined || (cursor.inclusive ? u >= cursor.after : u > cursor.after);
  const ordered = clean && rows.length <= limit + 1 && rows.every((r, i) => afterOk(r.updatedAt) && r.updatedAt <= cutoff && (i === 0 || rows[i - 1]!.updatedAt <= r.updatedAt));
  if (!ordered) return keepCursor(distinctRows([...rows].sort((a, b) => a.updatedAt - b.updatedAt)).slice(0, limit));
  if (rows.length <= limit) {                                                          // the end of the old-enough region: everything left is judged now
    return { plan: { cls, judged: distinctRows(rows), next: rows.length ? { after: rows[rows.length - 1]!.updatedAt } : cursor, caughtUp: true }, anomaly: false, queries: 1 };
  }
  // limit + 1 rows came back: the last one may belong to a group that continues beyond the result, so judge only what is strictly older than it
  const last = rows[limit]!.updatedAt;
  const older = rows.filter(r => r.updatedAt < last);
  if (older.length > 0) return { plan: { cls, judged: distinctRows(older), next: { after: older[older.length - 1]!.updatedAt }, caughtUp: false }, anomaly: false, queries: 1 };
  const walk = await planScan(ctx, cls, cutoff, limit, { ...cursor, tie: { updatedAt: last } });   // one group larger than a batch: walk it by key, starting now
  return { ...walk, queries: walk.queries + 1 };
}

interface ClassState { cursor: PromoteRetentionScanCursor; caughtUp: boolean }
const freshClass = (): ClassState => ({ cursor: {}, caughtUp: false });

/** Per-sweep scan state: O(1) per class, whatever the number of rows. */
export class RetentionScanState {
  private classes: Record<PromoteRetentionScanClass, ClassState> = { succeeded: freshClass(), failed: freshClass() };
  /** Alternates which class is scanned first when both are on, so neither can be starved by the other's backlog. */
  private turn = 0;
  /** Transient keeps since the last rewind: the earliest moment one of them can change, and the oldest such row per class. */
  private retry?: { notBefore: number; from: Partial<Record<PromoteRetentionScanClass, number>> };
  private rescanAt?: number;

  /**
   * @param active the scanned classes
   * @param rescanIntervalMs safety net: every this many ms (once a pass has reached the end) the scan restarts from the oldest row
   * @param retryRewinds whether a transiently kept row is revisited within the pass (delete mode); a report pass never judges a row twice
   */
  constructor(private readonly active: readonly PromoteRetentionScanClass[], private readonly rescanIntervalMs: number, private readonly retryRewinds: boolean) {}

  /** Classes in the order they are scanned in this call. */
  order(): PromoteRetentionScanClass[] {
    return this.active.length === 2 && this.turn++ % 2 === 1 ? [...this.active].reverse() : [...this.active];
  }

  cursorOf(cls: PromoteRetentionScanClass): PromoteRetentionScanCursor { return this.classes[cls].cursor; }

  /** Some scanned class has not reached the end of the old-enough rows yet. */
  get hasMore(): boolean { return !this.active.every(cls => this.classes[cls].caughtUp); }

  /**
   * Rewind before a scan: a full restart when the safety interval has elapsed (and every class reached its frontier), else back to the oldest transiently kept
   * row once it is due. Returns `'restart'` when a new pass begins.
   */
  rewindIfDue(now: number): 'restart' | undefined {
    this.rescanAt ??= now + this.rescanIntervalMs;
    if (now >= this.rescanAt && !this.hasMore) {
      for (const cls of this.active) this.classes[cls] = freshClass();
      this.retry = undefined;
      this.rescanAt = now + this.rescanIntervalMs;
      return 'restart';
    }
    const retry = this.retry;
    if (!retry || now < retry.notBefore) return undefined;
    for (const cls of this.active) {
      const from = retry.from[cls];
      if (from !== undefined && this.classes[cls].caughtUp) { this.classes[cls] = { cursor: { after: from, inclusive: true }, caughtUp: false }; delete retry.from[cls]; }
    }
    if (Object.keys(retry.from).length === 0) this.retry = undefined;   // classes still walking their pass keep their entry and rewind as soon as they have caught up
    return undefined;
  }

  /** Record a kept row: a permanent reason moves the cursor on for good, a transient one marks where it may be rewound to. */
  noteKept(candidate: ScanCandidate, reason: PromoteRetentionKeepReason, now: number, readyAt?: number): void {
    if (!this.retryRewinds || PERMANENT_KEEP_REASONS.has(reason)) return;
    const retry = (this.retry ??= { notBefore: Number.POSITIVE_INFINITY, from: {} });
    retry.notBefore = Math.min(retry.notBefore, readyAt ?? now + PENDING_RETRY_MS);
    retry.from[candidate.cls] = Math.min(retry.from[candidate.cls] ?? Number.POSITIVE_INFINITY, candidate.updatedAt);
  }

  /** Every slice succeeded: move the cursors past the rows that were judged (a class whose scan broke the contract keeps its cursor). */
  commit(plans: readonly ScanPlan[]): void {
    for (const plan of plans) this.classes[plan.cls] = plan.next ? { cursor: plan.next, caughtUp: plan.caughtUp } : { cursor: this.classes[plan.cls].cursor, caughtUp: false };
  }
}
