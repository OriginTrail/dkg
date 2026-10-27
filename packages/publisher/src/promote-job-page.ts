import { controlStoreOptions, type TripleStore } from '@origintrail-official/dkg-storage';
import type { PromoteJob, PromoteListFilter } from './async-promote-queue-types.js';
import {
  PROMOTE_CONTEXT_GRAPH_ID, PROMOTE_ENQUEUED_AT, PROMOTE_PAYLOAD, PROMOTE_STATE,
  expectBindings, integer, jobSubject, literal, parseIntegerLiteral, parseJobPayload,
} from './async-promote-queue-utils.js';
import { isSafeJobId } from './job-id.js';
import { comparePromoteJobCursors, type PromoteJobCursor } from './promote-list-cursor.js';

/**
 * One keyset page of the share queue's jobs (OT-RFC-73 P8a): the read behind the public listing, the paged route and the
 * post-commit sweep. `listUnlocked` (claimNext, recovery) keeps its complete read; nothing here changes what those see.
 *
 * Shape. Rows are ordered by `(enqueuedAt, jobId)`, two fields that never change for a job, and a page asks for the rows after
 * a cursor with `LIMIT n + 1` (the extra row only says that more follow). There is no `OFFSET`. The key read fetches no payload;
 * the payloads are then read for the page's own rows by subject. Both reads happen in the caller's one hold of the queue's mutex
 * on the control path, so no writer of this process runs between them.
 *
 * Cost. A page costs the rows that match the filter, not the page: the engine scans and orders them before it cuts. Measured on
 * Blazegraph (docs/investigations/async-queue-share-page-bound.md). `ORDER BY ?job` is used rather than a computed `STR(?job)`
 * because that is the cheaper plan; both orders are the code point order of the IRI, and `readPromoteJobPage` fails closed if a
 * store ever returns rows in another order, so a different collation cannot skip or repeat a job silently.
 */

/** What the listing reads need from the queue: its store, graph, mutex and admission coordinator. */
export interface PromoteListingHost {
  readonly store: TripleStore;
  readonly graphUri: string;
  readonly now: () => number;
  /** Rows per hold of the mutex in a complete listing. */
  readonly listPageSize: number;
  /** A complete listing of more rows than this logs a warning. */
  readonly listWarnRows: number;
  /** One hold of the queue's mutex, with the control graph created. */
  locked<T>(run: () => Promise<T>): Promise<T>;
  /** Show the admission coordinator a job the read returned; call it inside the hold that read it, never after. */
  observe(job: PromoteJob): void;
}

export interface PromotePageRead {
  readonly cursor?: PromoteJobCursor;
  readonly pageSize: number;
  /**
   * Source labels of the key read and the payload read: one string literal each, at the call site (AC1 static census). A read
   * with `payloadContainsAny` has no payload read and needs no second label.
   */
  readonly sources: { readonly keys: string; readonly payloads?: string };
  /**
   * Leave out, inside the engine, the rows whose payload text contains none of these. A superset pre-filter only: the caller
   * still judges every row it gets. With it the payload comes back in the key read and there is no second read.
   */
  readonly payloadContainsAny?: readonly string[];
}

export interface PromoteJobKeyPage {
  readonly jobs: PromoteJob[];
  /** The last row of this page, present exactly when more rows followed it at the time of the read. */
  readonly next?: PromoteJobCursor;
}

const JOB_SUBJECT_PREFIX = jobSubject('');

export function buildPromoteJobPageQuery(
  graphUri: string, filter: Pick<PromoteListFilter, 'state' | 'contextGraphId'>, read: Omit<PromotePageRead, 'sources'>,
): string {
  const contains = read.payloadContainsAny?.length ? read.payloadContainsAny : undefined;
  const where = [`?job <${PROMOTE_STATE}> ?state ; <${PROMOTE_ENQUEUED_AT}> ?enq .`];
  if (contains) where.push(`?job <${PROMOTE_PAYLOAD}> ?payload .`);
  if (filter.state && filter.state.length > 0) where.push(`VALUES ?state { ${[...new Set(filter.state)].map((s) => literal(s)).join(' ')} }`);
  if (filter.contextGraphId) where.push(`?job <${PROMOTE_CONTEXT_GRAPH_ID}> ${literal(filter.contextGraphId)} .`);
  if (contains) where.push(`FILTER (${contains.map((text) => `CONTAINS(STR(?payload), ${literal(text)})`).join(' || ')})`);
  if (read.cursor) {
    // The first filter is a plain range on the timestamp; the second keeps only the rows after the cursor within it. The job IRI is
    // compared as a string only for rows that share the cursor's timestamp.
    const at = integer(read.cursor.enqueuedAt);
    where.push(`FILTER (?enq >= ${at})`, `FILTER (?enq > ${at} || STR(?job) > ${literal(jobSubject(read.cursor.jobId))})`);
  }
  if (!Number.isSafeInteger(read.pageSize) || read.pageSize < 1) throw new RangeError('page size must be a positive integer');
  return `SELECT ?job ?enq${contains ? ' ?payload' : ''} WHERE { GRAPH <${graphUri}> { ${where.join(' ')} } } ORDER BY ?enq ?job LIMIT ${read.pageSize + 1}`;
}

function buildPayloadQuery(graphUri: string, jobIds: readonly string[]): string {
  return `SELECT ?job ?payload WHERE { GRAPH <${graphUri}> { VALUES ?job { ${jobIds.map((id) => `<${jobSubject(id)}>`).join(' ')} } ?job <${PROMOTE_PAYLOAD}> ?payload } }`;
}

type KeyRow = Record<string, string>;

/** The key a row names, or undefined for a subject that is not a share job (it is left out of the listing, as an undecodable payload is). */
function keyOf(row: KeyRow): PromoteJobCursor | undefined {
  const subject = row['job'];
  if (typeof subject !== 'string' || !subject.startsWith(JOB_SUBJECT_PREFIX)) return undefined;
  const jobId = subject.slice(JOB_SUBJECT_PREFIX.length);
  if (!isSafeJobId(jobId)) return undefined;
  try { return { enqueuedAt: parseIntegerLiteral(row['enq'] ?? ''), jobId }; } catch { return undefined; }
}

/** Read one page. Call it inside `host.locked`. */
export async function readPromoteJobPage(
  host: PromoteListingHost, filter: Pick<PromoteListFilter, 'state' | 'contextGraphId'>, read: PromotePageRead,
): Promise<PromoteJobKeyPage> {
  const rows = expectBindings(await host.store.query(
    buildPromoteJobPageQuery(host.graphUri, filter, read), controlStoreOptions('share', read.sources.keys)));
  const keyed = rows.flatMap((row, i) => { const key = keyOf(row); return key ? [{ key, row, onPage: i < read.pageSize }] : []; });
  for (let i = 0; i < keyed.length; i++) {
    const before = i === 0 ? read.cursor : keyed[i - 1]!.key;
    if (before && comparePromoteJobCursors(before, keyed[i]!.key) >= 0) {
      throw new Error('Share job listing: the store returned job keys out of order or at/before the cursor');
    }
  }
  const page = keyed.filter(({ onPage }) => onPage);
  const more = rows.length > read.pageSize;
  if (more && page.length === 0) throw new Error('Share job listing: a full page held no share job to continue from');

  let payloadOf: (row: KeyRow) => string | undefined = (row) => row['payload'];
  if (!read.payloadContainsAny?.length && page.length > 0) {
    if (!read.sources.payloads) throw new TypeError('A page read without a payload filter needs a payload source label');
    const payloads = new Map<string, string>();
    const found = expectBindings(await host.store.query(
      buildPayloadQuery(host.graphUri, page.map(({ key }) => key.jobId)), controlStoreOptions('share', read.sources.payloads)));
    for (const row of found) if (row['job'] !== undefined && row['payload'] !== undefined && !payloads.has(row['job'])) payloads.set(row['job'], row['payload']);
    payloadOf = (row) => payloads.get(row['job'] ?? '');
  }
  const jobs: PromoteJob[] = [];
  for (const { row } of page) {
    const job = parseJobPayload(payloadOf(row));
    if (!job) continue;
    host.observe(job);
    // The key read and the payload read are two reads. A writer outside this process (the mutex only orders this process's) can change
    // the job between them; a job that no longer matches the filter is left out, so every job returned satisfies it as read.
    if (filter.state?.length && !filter.state.includes(job.state)) continue;
    if (filter.contextGraphId && job.request.contextGraphId !== filter.contextGraphId) continue;
    jobs.push(job);
  }
  return { jobs, ...(more ? { next: page[page.length - 1]!.key } : {}) };
}
