import { Logger, createOperationContext } from '@origintrail-official/dkg-core';
import { controlStoreOptions } from '@origintrail-official/dkg-storage';
import {
  PROMOTE_JOB_STATES,
  type AsyncPromoteQueueConfig, type PromoteJob, type PromoteJobPage, type PromoteListFilter, type PromoteListPageRequest,
  type PromoteSelector, type PromoteStats,
} from './async-promote-queue-types.js';
import {
  PROMOTE_PAYLOAD, PROMOTE_STATE, PROMOTE_UNIQUENESS_KEY,
  comparePromoteJobs, expectBindings, literal, parseIntegerLiteral, parseJobPayload, parseLiteral, uniquenessLookupKeys,
} from './async-promote-queue-utils.js';
import {
  readPromoteJobKeys, readPromoteJobPage, readPromoteJobPayloads, readPromoteRetryTimes, type PromoteKeyPage, type PromoteListingHost,
} from './promote-job-page.js';
import {
  PROMOTE_LIST_MAX_PAGE_SIZE, decodePromoteJobCursor, encodePromoteJobCursor, resolvePromotePageSize, type PromoteJobCursor,
} from './promote-list-cursor.js';

/**
 * The share queue's listing, statistics and selector lookup (OT-RFC-73 P8a): everything the queue reads for its public list,
 * its statistics and the durable share path, kept out of the mutex-holding file. `claimNext` and recovery do not use any of it.
 *
 * Every read runs in a hold of the queue's mutex on the control path. A complete listing is a sequence of such holds, one per key
 * read and one per batch of payloads, and is therefore NOT a snapshot: a job that starts matching (arrives, or changes into the filter)
 * after the key read that covers its position is not seen, a job that changes but still matches is returned as its batch read it, a job
 * whose payload no longer matches the filter when its batch is read is left out, and a job that
 * matched the filter for the whole walk is always returned, once.
 */

const logger = new Logger('AsyncPromoteList');

/**
 * Payloads read per hold, keys read per ordered scan, and the row count above which a complete listing warns. A queue's config can
 * lower them (tests do). The key page is large because every key read is a scan of all the rows that match the filter (the engine
 * orders them before it cuts), so the number of scans of a complete listing is the rows over this size: about five at 50,000 retained jobs.
 */
export const PROMOTE_LIST_COMPLETE_PAGE_SIZE = PROMOTE_LIST_MAX_PAGE_SIZE;
export const PROMOTE_LIST_KEY_PAGE_SIZE = 10_000;
export const PROMOTE_LIST_MAX_KEY_PAGE_SIZE = 100_000;
export const PROMOTE_LIST_WARN_ROWS = 5_000;
const WARN_INTERVAL_MS = 60_000;

export function promoteListingTuning(config: Pick<AsyncPromoteQueueConfig, 'listPageSize' | 'listKeyPageSize' | 'listWarnRows'>) {
  const listPageSize = config.listPageSize ?? PROMOTE_LIST_COMPLETE_PAGE_SIZE;
  if (!Number.isSafeInteger(listPageSize) || listPageSize < 1 || listPageSize > PROMOTE_LIST_MAX_PAGE_SIZE) {
    throw new Error(`listPageSize must be an integer from 1 to ${PROMOTE_LIST_MAX_PAGE_SIZE}`);
  }
  const listKeyPageSize = config.listKeyPageSize ?? PROMOTE_LIST_KEY_PAGE_SIZE;
  if (!Number.isSafeInteger(listKeyPageSize) || listKeyPageSize < 1 || listKeyPageSize > PROMOTE_LIST_MAX_KEY_PAGE_SIZE) {
    throw new Error(`listKeyPageSize must be an integer from 1 to ${PROMOTE_LIST_MAX_KEY_PAGE_SIZE}`);
  }
  const listWarnRows = config.listWarnRows ?? PROMOTE_LIST_WARN_ROWS;
  // NaN would silence the warning for good and a value below one would fire it on every listing, so neither is a setting.
  if (typeof listWarnRows !== 'number' || !Number.isFinite(listWarnRows) || listWarnRows < 1) throw new Error('listWarnRows must be a finite number of at least 1');
  return { listPageSize, listKeyPageSize, listWarnRows };
}

const lastWarnedAt = new Map<string, number>();

function warnCompleteListing(host: PromoteListingHost, rows: number): void {
  const now = host.now();
  const last = lastWarnedAt.get(host.graphUri);
  if (last !== undefined && now >= last && now - last < WARN_INTERVAL_MS) return;
  lastWarnedAt.set(host.graphUri, now);
  logger.warn(createOperationContext('publish', 'promote-list'),
    `async_promote_list_complete rows=${rows} threshold=${host.listWarnRows}: a listing without a cursor reads the whole queue page by page; `
    + 'page it with a cursor (pageSize up to 1000) or filter by state');
}

const LIST_SOURCES = { keys: 'publisher.asyncPromote.list', payloads: 'publisher.asyncPromote.list.payloads' } as const;

/** The ready time `comparePromoteJobs` ranks a job by. */
const readyTime = (job: PromoteJob): number => job.attempt.nextRetryAt ?? job.enqueuedAt;

/**
 * The complete listing: every matching job in ready-time order (`comparePromoteJobs`), `limit` applied after the sort.
 *
 * About N / `listKeyPageSize` ordered scans plus linear payload batches: the ordered keys are read in key pages of `listKeyPageSize` (one
 * scan of the matching rows each, so about five at 50,000 retained jobs and not one per 1,000 rows), then the payloads of those keys in batches of `listPageSize` by subject. Every key read and every batch is its own
 * hold of the mutex, so no hold lasts for the whole history and none holds a full payload fetch.
 *
 * `limit` ends the walk early, without changing which jobs it keeps. Rows come in `(enqueuedAt, jobId)` order and the result is in ready
 * order, which differs only for a job with a `nextRetryAt`. So the walk keeps the `limit` best rows read so far and stops once the
 * last of them is strictly earlier than everything unread can be: the next unread key's `enqueuedAt`, or the earliest `nextRetryAt` of
 * an unread job (a retry time may be before its job's enqueue time after a clock step). A job whose retry time is not an integer counts as
 * the earliest possible one, and so does the retry time of a job the filter excludes (it is never read), which only makes the walk longer.
 * Strictly earlier, because a tie is broken by job id and an unread job could win it.
 *
 * Retry times change while a listing runs (a failing job gets one), so no stop rests on one read before the hold that decides it. The walk
 * reads them (`readPromoteRetryTimes`, one small query in a hold of its own) only when the enqueue bound and the values it holds say it
 * could stop, and stops only if the bound still holds with the values that read returned. If it does not, the walk goes on and keeps those
 * values to skip the read while they block a stop; a stale value can delay a stop but never cause one, because every stop follows a
 * fresh read. A retry time written after the read that confirmed the stop, like any change after a read, is a change after the walk.
 */
export async function listAllPromoteJobs(host: PromoteListingHost, filter: PromoteListFilter): Promise<PromoteJob[]> {
  const limit = filter.limit && filter.limit > 0 ? Math.floor(filter.limit) : undefined;
  if (limit === 0) return [];
  const readIds = new Set<string>();
  let retryAt: Map<string, number> | undefined;
  /** The ready time no unread job can precede, from the next unread key and the retry times last read. */
  const earliestUnread = (nextKey: PromoteJobCursor): number => {
    let earliest = nextKey.enqueuedAt;
    for (const [jobId, time] of retryAt ?? []) if (time < earliest && !readIds.has(jobId)) earliest = time;
    return earliest;
  };
  let jobs: PromoteJob[] = [];
  let rowsRead = 0;
  let cursor: PromoteJobCursor | undefined;
  walk: do {
    const keyPage: PromoteKeyPage = await host.locked(() => readPromoteJobKeys(host, filter, { cursor, pageSize: host.listKeyPageSize, source: LIST_SOURCES.keys }));
    for (let at = 0; at < keyPage.keys.length;) {
      // With a limit the first batch is no larger than it: the usual call (a few rows of a long queue) then reads one small batch.
      const size = limit && rowsRead === 0 && readIds.size === 0 ? Math.min(limit, host.listPageSize) : host.listPageSize;
      const keys = keyPage.keys.slice(at, at + size);
      at += keys.length;
      const batch = await host.locked(() => readPromoteJobPayloads(host, filter, keys, LIST_SOURCES.payloads));
      rowsRead += batch.length;
      jobs.push(...batch);
      if (!limit) continue;
      for (const key of keys) readIds.add(key.jobId);
      jobs.sort(comparePromoteJobs);
      if (jobs.length > limit) jobs = jobs.slice(0, limit);
      const nextKey = at < keyPage.keys.length ? keyPage.keys[at] : keyPage.next;
      if (!nextKey || jobs.length < limit) continue;
      const last = readyTime(jobs[limit - 1]!);
      if (last >= earliestUnread(nextKey)) continue;
      retryAt = await host.locked(() => readPromoteRetryTimes(host, LIST_SOURCES.keys));
      if (last < earliestUnread(nextKey)) break walk;
    }
    cursor = keyPage.next;
  } while (cursor);
  if (rowsRead > host.listWarnRows) warnCompleteListing(host, rowsRead);
  jobs.sort(comparePromoteJobs);
  return limit ? jobs.slice(0, limit) : jobs;
}

/** One page of the opt-in cursor listing. A malformed cursor or page size is a `PromoteListRequestError`, thrown before any read. */
export async function listPromoteJobsPage(
  host: PromoteListingHost, filter: Omit<PromoteListFilter, 'limit'>, request: PromoteListPageRequest,
): Promise<PromoteJobPage> {
  const cursor = request.cursor === undefined ? undefined : decodePromoteJobCursor(request.cursor);
  const pageSize = resolvePromotePageSize(request.pageSize);
  const page = await host.locked(() => readPromoteJobPage(host, filter, { cursor, pageSize, sources: LIST_SOURCES }));
  return page.next ? { jobs: page.jobs, nextCursor: encodePromoteJobCursor(page.next), complete: false } : { jobs: page.jobs, complete: true };
}

/** Jobs per state as one `COUNT ... GROUP BY ?state`; a state the queue does not know is not counted. */
export async function countPromoteJobsByState(host: PromoteListingHost): Promise<PromoteStats> {
  return host.locked(async () => {
    const rows = expectBindings(await host.store.query(
      `SELECT ?state (COUNT(?job) AS ?n) WHERE { GRAPH <${host.graphUri}> { ?job <${PROMOTE_STATE}> ?state } } GROUP BY ?state`,
      controlStoreOptions('share', 'publisher.asyncPromote.stats')));
    const stats = Object.fromEntries(PROMOTE_JOB_STATES.map((s) => [s, 0])) as PromoteStats;
    for (const row of rows) {
      let state: unknown;
      try { state = parseLiteral(row['state'] ?? ''); } catch { continue; }
      if ((PROMOTE_JOB_STATES as readonly unknown[]).includes(state)) stats[state as keyof PromoteStats] += parseIntegerLiteral(row['n'] ?? '');
    }
    return stats;
  });
}

/**
 * Every job stored under the selector's uniqueness key, in any state, in `list` order. The key is a constant of each pattern
 * (one POS range per spelling, as the conflict lookup reads it), so the cost follows the jobs of this selector and not the
 * queue's history. A job the engine reaches through two key spellings is returned once (identical payload text).
 */
export async function listPromoteJobsForSelector(host: PromoteListingHost, selector: PromoteSelector): Promise<PromoteJob[]> {
  const branches = uniquenessLookupKeys(selector).map((key) => `{ ?job <${PROMOTE_UNIQUENESS_KEY}> ${literal(key)} ; <${PROMOTE_PAYLOAD}> ?payload . }`);
  return host.locked(async () => {
    const rows = expectBindings(await host.store.query(
      `SELECT ?payload WHERE { GRAPH <${host.graphUri}> { ${branches.join(' UNION ')} } }`,
      controlStoreOptions('share', 'publisher.asyncPromote.selectorLookup')));
    const jobs = [...new Set(rows.map((row) => row['payload']))]
      .flatMap((payload) => { const job = parseJobPayload(payload); return job ? [job] : []; })
      .sort(comparePromoteJobs);
    for (const job of jobs) host.observe(job);
    return jobs;
  });
}
