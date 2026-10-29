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
 * CANDIDATES. A row is read only if its subject is an IRI under the queue's job prefix and its stored `finalizedAt` is an `xsd:integer` term of at least 0 (both queries carry
 * the same filters, so they select the same rows; the share scan has the same rules, async-promote-retention-scan.ts). A blank node has no `STR`, so `ORDER BY STR(?job)` leaves
 * its rows in engine order and the key check of the tie walk rejects them: an anomaly on every call, and the cursor never moves. An IRI outside the prefix is no job and could
 * only be kept; an ASCII one was harmless, but one that mixes astral and high BMP characters is ordered by code point in Oxigraph and by UTF-16 in the key check, with the same
 * effect. Neither is a candidate, so neither is read, judged or counted. (Under the prefix such an id needs a foreign writer, the queue's ids being ASCII, `isSafeJobId`; on
 * an engine that orders by code point the tie walk then fails closed as for any reordering: an anomaly on every call that meets the pair, and the cursor does not move past it.)
 * The cursor holds a JS number and the engine compares terms exactly, so a term a double cannot represent reads back as a number the engine does not consider equal to it:
 * `"100.0000000000000001"^^xsd:decimal` reads as 100, the tie walk at 100 does not return it and the range scan `> 100` does, so the cursor would never leave it, and every
 * eligible job behind it would starve. An integer in [0, cutoff] is exact in a double, so the number the cursor holds IS the term (the queue writes nothing else). A job whose
 * only finish times are other terms (a decimal, a double, a plain literal, a negative number) is never a candidate: it is not read, judged, counted or deleted, so it stays, and
 * so does every newer record of its key, which the sweep keeps as `older_sibling_kept` because the stored-index check of older siblings reads the same rule
 * (async-lift-retention.ts).
 *
 * REPEATED ROWS. One subject can still come back as several rows: an engine that keeps two integer lexical forms of one value apart (`"100"`, `"0100"`; Oxigraph merges
 * them) answers it once per term, and a job indexed at two distinct integers (the queue never writes that) comes back at each. The rows of a subject in one answer are collapsed
 * to one judged row, a window of limit + 1 ROWS counts as full however few subjects the repeats left in it, and the walk goes on after the last subject judged, so repeats cost
 * calls and never stall. A job indexed at two values is judged once per answer it is in, and kept each time (`index_mismatch`: its index does not match its one payload). A job
 * indexed at an integer and at an equal decimal (`100`, `100.0`) is read at the integer alone, and kept for the same reason.
 *
 * The scan runs outside the claim lock, on the background lane (OT-RFC-73 §5.1 tagging table: it is not queue control work). It reads only the two stored
 * index triples; the payload is judged later, under the lock.
 */
import type { QueryOptions, TripleStore } from '@origintrail-official/dkg-storage';
import { CONTROL_FINALIZED_AT, CONTROL_STATUS, XSD_INTEGER, jobSubject, literal } from './async-lift-control-plane.js';
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
/** The terms a scan may read: exact integers, which a JS number holds without loss (see CANDIDATES). Both scan queries carry it, so they select the same rows. */
const EXACT_FINISH_TIME = `FILTER (DATATYPE(?finalizedAt) = <${XSD_INTEGER}> && ?finalizedAt >= 0)`;
/** The subjects a scan may read: IRIs under the queue's job prefix (see CANDIDATES: a blank node, or an IRI elsewhere, could stall the tie walk). Both scan queries carry it. */
const JOB_SUBJECT_ONLY = `FILTER (isIRI(?job)) FILTER (STRSTARTS(STR(?job), ${literal(LIFT_JOB_SUBJECT_PREFIX)}))`;
const INTEGER_TERM_END = `"^^<${XSD_INTEGER}>`;
/** The finish time a stored term holds when the scan reads it (an `xsd:integer` of at least 0, exact in a JS number), else undefined: the sweep's index checks use the same rule. */
export function exactFinishTime(term: string | undefined): number | undefined {
  if (term === undefined || !term.startsWith('"') || !term.endsWith(INTEGER_TERM_END)) return undefined;
  const lexical = term.slice(1, -INTEGER_TERM_END.length);
  const value = /^\+?\d+$/.test(lexical) ? Number(lexical) : Number.NaN;
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Candidate scan: the rows whose stored `status` is finalized and whose stored `finalizedAt` lies after the cursor and not after `cutoff`, oldest first. It asks for
 * ONE row more than `limit`, so "fewer than limit + 1 rows" means "the end of the old-enough region was reached". The status is the constant object of the
 * pattern, not a FILTER.
 */
export function buildLiftRetentionScanQuery(graph: string, cutoff: number, limit: number, cursor: LiftRetentionScanCursor = {}): string {
  const lower = cursor.after === undefined ? '' : ` FILTER (?finalizedAt > ${num(cursor.after)})`;
  return `SELECT ?job ?finalizedAt WHERE { GRAPH <${graph}> { ?job <${CONTROL_STATUS}> ${literal('finalized')} ; <${CONTROL_FINALIZED_AT}> ?finalizedAt . ${EXACT_FINISH_TIME} ${JOB_SUBJECT_ONLY} FILTER (?finalizedAt <= ${num(cutoff)})${lower} } } ORDER BY ?finalizedAt LIMIT ${limit + 1}`;
}

/** The finalized rows that share exactly one `finalizedAt`, in key order after `afterKey` (only used inside a group larger than one batch). */
export function buildLiftRetentionTieQuery(graph: string, finalizedAt: number, limit: number, afterKey?: string): string {
  const after = afterKey === undefined ? '' : ` FILTER (STR(?job) > ${literal(afterKey)})`;
  return `SELECT ?job ?finalizedAt WHERE { GRAPH <${graph}> { ?job <${CONTROL_STATUS}> ${literal('finalized')} ; <${CONTROL_FINALIZED_AT}> ?finalizedAt . ${EXACT_FINISH_TIME} ${JOB_SUBJECT_ONLY} FILTER (?finalizedAt = ${num(finalizedAt)})${after} } } ORDER BY STR(?job) LIMIT ${limit + 1}`;
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
/**
 * The WALK ORDER: by finish time, then by subject (#3554). The tie scan returns the rows of one finish time in it (ORDER BY STR(?job), checked), and every plan sorts the
 * rows it judges into it, so a batch never judges two rows of one finish time in the engine's order. The sweep's key rule compares records in this order.
 */
export const byWalk = (a: LiftScanRow, b: LiftScanRow): number => a.finalizedAt - b.finalizedAt || byIri(a, b);
/** One row per subject, the first of an ordered answer (the oldest): a subject whose index holds several matching terms comes back once per term. */
const distinctRows = (rows: readonly LiftScanRow[]): LiftScanRow[] => { const seen = new Set<string>(); return rows.filter(r => (seen.has(r.iri) ? false : (seen.add(r.iri), true))); };
/** The rows to judge, in the walk order, one per subject (the oldest of its rows). */
const inWalkOrder = (rows: readonly LiftScanRow[]): LiftScanRow[] => distinctRows([...rows].sort(byWalk));

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
    const ordered = clean && rows.length <= limit + 1 && rows.every((r, i) => r.finalizedAt === finalizedAt && (afterKey === undefined || r.iri > afterKey) && (i === 0 || rows[i - 1]!.iri <= r.iri));   // <=: a subject's own rows are adjacent
    if (!ordered) return keepCursor(inWalkOrder(rows).slice(0, limit));
    const judged = distinctRows(rows).slice(0, limit);
    // limit + 1 rows = a full window, which may hide more subjects even when repeats left fewer than limit + 1 of them: continue after the last subject judged
    return { plan: { judged, next: rows.length <= limit ? { after: finalizedAt } : { ...cursor, tie: { finalizedAt, afterKey: judged[judged.length - 1]!.iri } }, caughtUp: false }, anomaly: false, queries: 1 };
  }
  const { rows, clean } = parseScanRows(expectBindings(await ctx.store.query(buildLiftRetentionScanQuery(ctx.graphUri, cutoff, limit, cursor), SCAN_OPTIONS)));
  const afterOk = (t: number) => cursor.after === undefined || t > cursor.after;
  const ordered = clean && rows.length <= limit + 1 && rows.every((r, i) => afterOk(r.finalizedAt) && r.finalizedAt <= cutoff && (i === 0 || rows[i - 1]!.finalizedAt <= r.finalizedAt));
  if (!ordered) return keepCursor(inWalkOrder(rows).slice(0, limit));
  if (rows.length <= limit) {                                                          // the end of the old-enough region: everything left is judged now
    return { plan: { judged: inWalkOrder(rows), next: rows.length ? { after: rows[rows.length - 1]!.finalizedAt } : cursor, caughtUp: true }, anomaly: false, queries: 1 };
  }
  // limit + 1 rows came back: the last one may belong to a group that continues beyond the result, so judge only what is strictly older than it
  const last = rows[limit]!.finalizedAt;
  const older = rows.filter(r => r.finalizedAt < last);
  if (older.length > 0) return { plan: { judged: inWalkOrder(older), next: { after: older[older.length - 1]!.finalizedAt }, caughtUp: false }, anomaly: false, queries: 1 };
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
