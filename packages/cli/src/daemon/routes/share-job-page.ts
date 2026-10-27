// daemon/routes/share-job-page.ts
//
// OT-RFC-73 P9b: the paged mode of `GET /api/knowledge-assets/swm/share-jobs`. The route calls the share queue's
// `listPage` directly (`agent.promoteQueue`, as `durable-synchronous-share.ts` does), so the agent facade does not grow.
//
// The body is `{ jobs, nextCursor, complete }` in the queue's keyset order (`enqueuedAt`, then `jobId`), which is not the
// ready-time order of the complete listing. `nextCursor` is null exactly when `complete` is true, and `complete` means no
// further row when this page was read, never proof that nothing was admitted since. A malformed cursor or page size is the
// queue's `PromoteListRequestError`, answered `400` with its own stable code. A fault in the stored rows (the queue's
// 'Share job listing:' errors) is logged and rethrown with a fixed message (`list-page-fault.ts`). Anything else, store pressure
// included, is rethrown as it is for the daemon's one error mapping (a retryable `503` for the scheduler; `500` otherwise).

import { PromoteListRequestError, type PromoteJobState } from '@origintrail-official/dkg-publisher';
import type { RequestContext } from './context.js';
import { failPageFault } from './list-page-fault.js';
import type { ListPaging } from './list-paging-query.js';
import { promoteJobToView } from './shared-assertion-helpers.js';
import { jsonResponse } from '../http-utils.js';

/** The queue raises its faults in the stored rows (keys out of order, a full page with no job, a position that is no cursor) as plain errors with this prefix. */
const STORED_ROW_FAULT = 'Share job listing:';

export async function respondShareJobPage(
  ctx: RequestContext,
  filter: { state?: PromoteJobState[]; contextGraphId?: string },
  paging: Extract<ListPaging, { paged: true }>,
): Promise<void> {
  const queue = ctx.agent.promoteQueue;
  if (!queue.listPage) {
    return jsonResponse(ctx.res, 501, { error: 'This node cannot page the share job list; list without a cursor', code: 'PROMOTE_LIST_PAGING_UNSUPPORTED' });
  }
  try {
    const page = await queue.listPage(filter, { cursor: paging.cursor, pageSize: paging.pageSize });
    return jsonResponse(ctx.res, 200, { jobs: page.jobs.map(promoteJobToView), nextCursor: page.nextCursor ?? null, complete: page.complete });
  } catch (err) {
    if (err instanceof PromoteListRequestError) return jsonResponse(ctx.res, 400, { error: err.message, code: err.code });
    if (err instanceof Error && err.message.startsWith(STORED_ROW_FAULT)) failPageFault('GET /api/knowledge-assets/swm/share-jobs', 'stored_rows', err);
    throw err;
  }
}
