// daemon/routes/publisher-job-page.ts
//
// OT-RFC-73 P9b: the query validation and the paged mode of `GET /api/publisher/jobs`.
//
// Without `cursor` and `pageSize` the route answers `{ jobs }` from the queue's complete `list()`, exactly as before. Keeping
// `list()` for that default also keeps its order: the page orders jobs accepted in the same millisecond by job id code unit
// and `list()` orders them with `localeCompare`, so a client that walks pages sees that difference and the default does not.
// The paged body is `{ jobs, nextCursor, complete }` in key order (`acceptedAt`, then `jobId`); `nextCursor` is null exactly
// when `complete` is true, and `complete` means no further row when this page was read, never proof that nothing was accepted
// since. A page can hold fewer jobs than `pageSize` while `nextCursor` is set (a row that no longer decodes is skipped).
//
// A malformed cursor (including a cursor of the share queue), a bad page size and an unknown status are `400` with a stable
// code. The queue's `unreadable_row` and `unordered_page` are faults of the stored rows, not of the request: they are logged
// (one warn line) and rethrown with a fixed message, because the queue's own message can name a job subject (`list-page-fault.ts`).
// Everything else, store pressure included, is rethrown as it is for the daemon's one error mapping (`503` for the scheduler,
// `500` otherwise).

import type { ServerResponse } from 'node:http';
import {
  LIFT_JOB_STATES,
  LiftJobPageError,
  type LiftJobState,
  type VmPublisherControl,
} from '@origintrail-official/dkg-publisher';
import { failPageFault } from './list-page-fault.js';
import { parseListPaging, type ListPaging } from './list-paging-query.js';
import { jsonResponse } from '../http-utils.js';
import { publisherJobView } from './publisher-job-view.js';

export interface PublisherJobsQuery {
  readonly status: LiftJobState | undefined;
  readonly paging: ListPaging;
}

/** Stable `400` codes of the paged publisher listing, by the queue's error code. */
const REQUEST_ERRORS = {
  malformed_cursor: { error: 'cursor is not a valid publisher job cursor', code: 'PUBLISHER_LIST_CURSOR_INVALID' },
  invalid_limit: { error: 'pageSize must be an integer from 1 to 1000', code: 'PUBLISHER_LIST_PAGE_SIZE_INVALID' },
} as const;

/** The route's `status` and paging parameters, or `null` after answering `400`. An empty `status` is no filter, as it always was. */
export function parsePublisherJobsQuery(url: URL, res: ServerResponse): PublisherJobsQuery | null {
  const status = url.searchParams.get('status') || undefined;
  if (status !== undefined && !(LIFT_JOB_STATES as readonly string[]).includes(status)) {
    jsonResponse(res, 400, { error: `Invalid status filter. Allowed: ${LIFT_JOB_STATES.join(',')}`, code: 'PUBLISHER_LIST_STATUS_INVALID' });
    return null;
  }
  const paging = parseListPaging(url, res);
  return paging && { status: status as LiftJobState | undefined, paging };
}

export async function respondPublisherJobs(
  res: ServerResponse,
  publisherControl: VmPublisherControl,
  query: PublisherJobsQuery,
  contextGraphId: string | null,
): Promise<void> {
  const filter = {
    ...(query.status ? { status: query.status } : {}),
    ...(contextGraphId === null ? {} : { contextGraphId }),
  };
  if (!query.paging.paged) return jsonResponse(res, 200, { jobs: (await publisherControl.list(filter)).map(publisherJobView) });
  try {
    const page = await publisherControl.listPage({ ...filter, cursor: query.paging.cursor, limit: query.paging.pageSize });
    return jsonResponse(res, 200, { jobs: page.jobs.map(publisherJobView), nextCursor: page.nextCursor, complete: page.complete });
  } catch (err) {
    const rejected = err instanceof LiftJobPageError ? REQUEST_ERRORS[err.code as keyof typeof REQUEST_ERRORS] : undefined;
    if (rejected) return jsonResponse(res, 400, rejected);
    if (err instanceof LiftJobPageError) failPageFault('GET /api/publisher/jobs', err.code, err);
    throw err;
  }
}
