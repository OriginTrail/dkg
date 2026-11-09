import { controlStoreOptions, type TripleStore } from '@origintrail-official/dkg-storage';
import type { PromoteJob, PromoteListFilter } from './async-promote-queue-types.js';
import {
  PROMOTE_CONTEXT_GRAPH_ID, PROMOTE_ENQUEUED_AT, PROMOTE_NEXT_RETRY_AT, PROMOTE_PAYLOAD, PROMOTE_STATE,
  expectBindings, integer, jobSubject, literal, parseIntegerLiteral, parseJobPayload,
} from './async-promote-queue-utils.js';
import { isSafeJobId } from './job-id.js';
import { PromoteListStoredRowError, comparePromoteJobCursors, type PromoteJobCursor } from './promote-list-cursor.js';

/**
 * Reads of the share queue's jobs by key (OT-RFC-73 P8a): the keyset page behind the paged listing and the post-commit sweep, and the
 * three reads the complete listing is made of. `listUnlocked` (claimNext, recovery) keeps its complete read; nothing here changes what
 * those see.
 *
 * Shape. Rows are ordered by `(enqueuedAt, jobId)`, two fields that never change for a job, and a read of keys asks for the rows after
 * a cursor with `LIMIT n + 1` (the extra row only says that more follow). There is no `OFFSET`. A key read fetches no payload; the
 * payloads are read for given rows by subject. `readPromoteJobPage` does both in the caller's one hold of the queue's mutex on the
 * control path, so no writer of this process runs between them; the complete listing (promote-job-listing.ts) holds the mutex once
 * per key read and once per payload batch, and `readPromoteJobPayloads` re-checks every row it decodes against the filter, so a job
 * that changed between the two holds is left out and never returned in a state the filter refuses.
 *
 * Cost. A key read costs the rows that match the filter, not its page: the engine scans and orders them before it cuts. Measured on
 * Blazegraph (docs/investigations/async-queue-share-page-bound.md). `ORDER BY ?job` is used rather than a computed `STR(?job)`
 * because that is the cheaper plan; both orders are the code point order of the IRI, and the key read fails closed if a store
 * ever returns rows in another order, so a different collation cannot skip or repeat a job silently.
 */

/** What the listing reads need from the queue: its store, graph, mutex and admission coordinator. */
export interface PromoteListingHost {
  readonly store: TripleStore;
  readonly graphUri: string;
  readonly now: () => number;
  /** Payloads read per hold of the mutex in a complete listing. */
  readonly listPageSize: number;
  /** Keys read per hold (and per ordered scan) in a complete listing. */
  readonly listKeyPageSize: number;
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
  // DISTINCT: a record with a second state triple (corruption, the queue never writes one) would otherwise come back once per triple, and a repeated key
  // is indistinguishable here from a store that ignores the cursor, so every walk of an unfiltered queue would fail. A real reordering still does.
  return `SELECT DISTINCT ?job ?enq${contains ? ' ?payload' : ''} WHERE { GRAPH <${graphUri}> { ${where.join(' ')} } } ORDER BY ?enq ?job LIMIT ${read.pageSize + 1}`;
}

function buildPayloadQuery(graphUri: string, jobIds: readonly string[]): string {
  return `SELECT ?job ?payload WHERE { GRAPH <${graphUri}> { VALUES ?job { ${jobIds.map((id) => `<${jobSubject(id)}>`).join(' ')} } ?job <${PROMOTE_PAYLOAD}> ?payload } }`;
}

type KeyRow = Record<string, string>;
interface KeyedRow { readonly key: PromoteJobCursor; readonly row: KeyRow }

/** The key a row names, or undefined for a subject that is not a share job (it is left out of the listing, as an undecodable payload is). */
function keyOf(row: KeyRow): PromoteJobCursor | undefined {
  const subject = row['job'];
  if (typeof subject !== 'string' || !subject.startsWith(JOB_SUBJECT_PREFIX)) return undefined;
  const jobId = subject.slice(JOB_SUBJECT_PREFIX.length);
  if (!isSafeJobId(jobId)) return undefined;
  try { return { enqueuedAt: parseIntegerLiteral(row['enq'] ?? ''), jobId }; } catch { return undefined; }
}

/** One ordered key read: the page's rows with their keys, and the last key when more rows followed. Call it inside `host.locked`. */
async function readKeyRows(
  host: PromoteListingHost, filter: Pick<PromoteListFilter, 'state' | 'contextGraphId'>,
  read: Omit<PromotePageRead, 'sources'> & { readonly source: string },
): Promise<{ page: KeyedRow[]; next?: PromoteJobCursor }> {
  const rows = expectBindings(await host.store.query(buildPromoteJobPageQuery(host.graphUri, filter, read), controlStoreOptions('share', read.source)));
  const keyed = rows.flatMap((row, i) => { const key = keyOf(row); return key ? [{ key, row, onPage: i < read.pageSize }] : []; });
  for (let i = 0; i < keyed.length; i++) {
    const before = i === 0 ? read.cursor : keyed[i - 1]!.key;
    if (before && comparePromoteJobCursors(before, keyed[i]!.key) >= 0) {
      throw new PromoteListStoredRowError('unordered_page', 'Share job listing: the store returned job keys out of order or at/before the cursor');
    }
  }
  const page = keyed.filter(({ onPage }) => onPage);
  const more = rows.length > read.pageSize;
  if (more && page.length === 0) throw new PromoteListStoredRowError('unresumable_page', 'Share job listing: a full page held no share job to continue from');
  return { page: page.map(({ key, row }) => ({ key, row })), ...(more ? { next: page[page.length - 1]!.key } : {}) };
}

/** The payload text of each given job, by subject. A job with no payload triple is absent from the map. */
async function fetchPayloads(host: PromoteListingHost, keys: readonly PromoteJobCursor[], source: string): Promise<Map<string, string>> {
  const found = expectBindings(await host.store.query(buildPayloadQuery(host.graphUri, keys.map(({ jobId }) => jobId)), controlStoreOptions('share', source)));
  const payloads = new Map<string, string>();
  for (const row of found) if (row['job'] !== undefined && row['payload'] !== undefined && !payloads.has(row['job'])) payloads.set(row['job'], row['payload']);
  return payloads;
}

/** Decode the payloads in order, show each job to the admission coordinator, and keep those that satisfy the filter as decoded. */
function decodeJobs(host: PromoteListingHost, filter: Pick<PromoteListFilter, 'state' | 'contextGraphId'>, payloads: Iterable<string | undefined>): PromoteJob[] {
  const jobs: PromoteJob[] = [];
  for (const payload of payloads) {
    const job = parseJobPayload(payload);
    if (!job) continue;
    host.observe(job);
    // A key read and the read of its payload are two reads. A writer outside this process (the mutex only orders this process's), or in a
    // complete listing another hold of this one, can change the job between them; a job that no longer matches the filter is left out, so
    // every job returned satisfies the filter as read.
    if (filter.state?.length && !filter.state.includes(job.state)) continue;
    if (filter.contextGraphId && job.request.contextGraphId !== filter.contextGraphId) continue;
    jobs.push(job);
  }
  return jobs;
}

export interface PromoteKeyPage {
  readonly keys: PromoteJobCursor[];
  /** The last key of this page, present exactly when more rows followed it at the time of the read. */
  readonly next?: PromoteJobCursor;
}

/** The keys of one page, no payload. Call it inside `host.locked`. */
export async function readPromoteJobKeys(
  host: PromoteListingHost, filter: Pick<PromoteListFilter, 'state' | 'contextGraphId'>,
  read: { readonly cursor?: PromoteJobCursor; readonly pageSize: number; readonly source: string },
): Promise<PromoteKeyPage> {
  const { page, next } = await readKeyRows(host, filter, read);
  return { keys: page.map(({ key }) => key), ...(next ? { next } : {}) };
}

/** The jobs of the given keys, in the order given, those that still satisfy the filter. Call it inside `host.locked`. */
export async function readPromoteJobPayloads(
  host: PromoteListingHost, filter: Pick<PromoteListFilter, 'state' | 'contextGraphId'>, keys: readonly PromoteJobCursor[], source: string,
): Promise<PromoteJob[]> {
  if (keys.length === 0) return [];
  const payloads = await fetchPayloads(host, keys, source);
  return decodeJobs(host, filter, keys.map(({ jobId }) => payloads.get(jobSubject(jobId))));
}

/**
 * `nextRetryAt` of every job that has one, by job id (one read of the triples that carry it: the jobs waiting to retry). A literal that is
 * not an integer counts as the earliest possible time, which only makes the caller read more. Call it inside `host.locked`.
 */
export async function readPromoteRetryTimes(host: PromoteListingHost, source: string): Promise<Map<string, number>> {
  const rows = expectBindings(await host.store.query(
    `SELECT ?job ?retry WHERE { GRAPH <${host.graphUri}> { ?job <${PROMOTE_NEXT_RETRY_AT}> ?retry } }`, controlStoreOptions('share', source)));
  const times = new Map<string, number>();
  for (const row of rows) {
    const subject = row['job'];
    if (typeof subject !== 'string' || !subject.startsWith(JOB_SUBJECT_PREFIX)) continue;
    let at = Number.NEGATIVE_INFINITY;
    try { at = parseIntegerLiteral(row['retry'] ?? ''); } catch { /* counts as the earliest time */ }
    const jobId = subject.slice(JOB_SUBJECT_PREFIX.length);
    times.set(jobId, Math.min(at, times.get(jobId) ?? at));
  }
  return times;
}

/** Read one page: its keys, then the payloads of its rows (or the payload that came with them). Call it inside `host.locked`. */
export async function readPromoteJobPage(
  host: PromoteListingHost, filter: Pick<PromoteListFilter, 'state' | 'contextGraphId'>, read: PromotePageRead,
): Promise<PromoteJobKeyPage> {
  const { page, next } = await readKeyRows(host, filter, { ...read, source: read.sources.keys });
  let payloads: Array<string | undefined>;
  if (read.payloadContainsAny?.length) payloads = page.map(({ row }) => row['payload']);
  else if (page.length === 0) payloads = [];
  else {
    if (!read.sources.payloads) throw new TypeError('A page read without a payload filter needs a payload source label');
    const found = await fetchPayloads(host, page.map(({ key }) => key), read.sources.payloads);
    payloads = page.map(({ key }) => found.get(jobSubject(key.jobId)));
  }
  return { jobs: decodeJobs(host, filter, payloads), ...(next ? { next } : {}) };
}
