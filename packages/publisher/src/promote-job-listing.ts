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
import { readPromoteJobPage, type PromoteJobKeyPage, type PromoteListingHost } from './promote-job-page.js';
import {
  PROMOTE_LIST_MAX_PAGE_SIZE, decodePromoteJobCursor, encodePromoteJobCursor, resolvePromotePageSize, type PromoteJobCursor,
} from './promote-list-cursor.js';

/**
 * The share queue's listing, statistics and selector lookup (OT-RFC-73 P8a): everything the queue reads for its public list,
 * its statistics and the durable share path, kept out of the mutex-holding file. `claimNext` and recovery do not use any of it.
 *
 * Every read runs in a hold of the queue's mutex on the control path. A complete listing is a loop of such holds, one per page,
 * and is therefore NOT a snapshot: a job that changes state or arrives while the loop runs is seen as it is when its page is
 * read, once at most, and a job that matched the filter for the whole walk is always returned.
 */

const logger = new Logger('AsyncPromoteList');

/** Rows read per hold by a complete listing, and the row count above which one warns. A queue's config can lower them (tests do). */
export const PROMOTE_LIST_COMPLETE_PAGE_SIZE = PROMOTE_LIST_MAX_PAGE_SIZE;
export const PROMOTE_LIST_WARN_ROWS = 5_000;
const WARN_INTERVAL_MS = 60_000;

export function promoteListingTuning(config: Pick<AsyncPromoteQueueConfig, 'listPageSize' | 'listWarnRows'>) {
  const listPageSize = config.listPageSize ?? PROMOTE_LIST_COMPLETE_PAGE_SIZE;
  if (!Number.isSafeInteger(listPageSize) || listPageSize < 1 || listPageSize > PROMOTE_LIST_MAX_PAGE_SIZE) {
    throw new Error(`listPageSize must be an integer from 1 to ${PROMOTE_LIST_MAX_PAGE_SIZE}`);
  }
  const listWarnRows = config.listWarnRows ?? PROMOTE_LIST_WARN_ROWS;
  // NaN would silence the warning for good and a value below one would fire it on every listing, so neither is a setting.
  if (typeof listWarnRows !== 'number' || !Number.isFinite(listWarnRows) || listWarnRows < 1) throw new Error('listWarnRows must be a finite number of at least 1');
  return { listPageSize, listWarnRows };
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

/**
 * The complete listing: every matching job in ready-time order (`comparePromoteJobs`), `limit` applied after the sort. Read as a
 * loop of keyset pages, each in its own hold of the mutex, so no hold lasts for the whole history.
 */
export async function listAllPromoteJobs(host: PromoteListingHost, filter: PromoteListFilter): Promise<PromoteJob[]> {
  const jobs: PromoteJob[] = [];
  let cursor: PromoteJobCursor | undefined;
  do {
    const page: PromoteJobKeyPage = await host.locked(() => readPromoteJobPage(host, filter, { cursor, pageSize: host.listPageSize, sources: LIST_SOURCES }));
    for (const job of page.jobs) jobs.push(job);
    cursor = page.next;
  } while (cursor);
  if (jobs.length > host.listWarnRows) warnCompleteListing(host, jobs.length);
  jobs.sort(comparePromoteJobs);
  return filter.limit && filter.limit > 0 ? jobs.slice(0, Math.floor(filter.limit)) : jobs;
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
