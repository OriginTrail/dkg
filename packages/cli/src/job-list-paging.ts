import { parsePositiveIntegerOption } from './cli-option-parsers.js';

/**
 * The CLI side of the paged job lists (OT-RFC-73 P9b): `ka share-jobs` and `publisher jobs` take `--cursor`, `--page-size`
 * and `--all`. A page is `{ jobs, nextCursor, complete }`; `complete` means no further job when that page was read, so a
 * walk that reached it has listed every job the daemon held when each page was read, and nothing more. In particular a job
 * that is not in the output is not thereby proven absent: one admitted behind the walk is simply not part of it.
 */
export interface JobListPage<T> {
  jobs: T[];
  nextCursor?: string | null;
  complete?: boolean;
}

export interface JobListPagingOptions {
  /** `--cursor`: the `nextCursor` of an earlier page. */
  cursor?: string;
  /** `--page-size`: jobs per request. */
  pageSize?: number;
  /** `--all`: page through to the end and return every job. */
  all: boolean;
}

/** The paging flags of a list command, or `null` when none is given and the command keeps its complete, unchanged output. */
export function parseJobListPagingOptions(opts: Record<string, unknown>): JobListPagingOptions | null {
  const cursor = opts.cursor === undefined ? undefined : String(opts.cursor);
  const pageSize = opts.pageSize === undefined ? undefined : parsePositiveIntegerOption(String(opts.pageSize), '--page-size');
  const all = opts.all === true;
  if (cursor === undefined && pageSize === undefined && !all) return null;
  if (all && cursor !== undefined) throw new Error('--all starts from the first page; it cannot be combined with --cursor');
  if (opts.limit !== undefined) throw new Error('--limit caps the complete list; use --page-size with --cursor or --all instead');
  return { cursor, pageSize, all };
}

/** A paged request must be answered with the paging fields; an unpaged answer means the daemon ignored the parameters. */
function requirePaged<T>(page: JobListPage<T>): JobListPage<T> {
  if (typeof page.complete !== 'boolean') {
    throw new Error('The node answered with an unpaged list, so it does not support --cursor, --page-size or --all; update and restart it');
  }
  return page;
}

/** Jobs per request of `--all`: the daemon's maximum, so a long list takes the fewest requests. */
const ALL_PAGE_SIZE = 1_000;

type FetchJobPage<T> = (cursor: string | undefined, pageSize: number | undefined) => Promise<JobListPage<T>>;

/** Every job, page after page until a page is complete. A cursor that does not move on stops the walk instead of looping. */
async function collectAllJobs<T>(fetchPage: FetchJobPage<T>, pageSize: number): Promise<T[]> {
  const jobs: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = requirePaged(await fetchPage(cursor, pageSize));
    jobs.push(...page.jobs);
    if (page.complete) return jobs;
    if (typeof page.nextCursor !== 'string' || page.nextCursor === '' || page.nextCursor === cursor) {
      throw new Error(`The node did not return a new cursor for an incomplete page; stopped after ${jobs.length} jobs`);
    }
    cursor = page.nextCursor;
  }
}

/**
 * The read of a list command. Without paging flags it is `complete()`, the command's unchanged call. `--all` is `{ jobs }` of
 * every page, the shape of the complete answer; otherwise one page, `{ jobs, nextCursor, complete }`.
 */
export async function readJobList<T>(
  paging: JobListPagingOptions | null,
  complete: () => Promise<JobListPage<T>>,
  fetchPage: FetchJobPage<T>,
): Promise<JobListPage<T>> {
  if (!paging) return complete();
  if (paging.all) return { jobs: await collectAllJobs(fetchPage, paging.pageSize ?? ALL_PAGE_SIZE) };
  return requirePaged(await fetchPage(paging.cursor, paging.pageSize));
}
