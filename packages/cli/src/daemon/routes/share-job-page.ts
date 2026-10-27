// daemon/routes/share-job-page.ts
//
// OT-RFC-73 P9b: the paged mode of `GET /api/knowledge-assets/swm/share-jobs`. The route calls the share queue's
// `listPage` directly (`agent.promoteQueue`, as `durable-synchronous-share.ts` does), so the agent facade does not grow.
//
// The body is `{ jobs, nextCursor, complete }` in the queue's keyset order (`enqueuedAt`, then `jobId`), which is not the
// ready-time order of the complete listing. `nextCursor` is null exactly when `complete` is true, and `complete` means no
// further row when this page was read, never proof that nothing was admitted since. A malformed cursor or page size is the
// queue's `PromoteListRequestError`, answered `400` with its own stable code. Anything else, store pressure included, is
// rethrown for the daemon's one error mapping (a retryable `503` for the scheduler; `500` for a fault in the stored rows).

import { PromoteListRequestError, type PromoteJobState } from '@origintrail-official/dkg-publisher';
import type { RequestContext } from './context.js';
import type { ListPaging } from './list-paging-query.js';
import { promoteJobToView } from './shared-assertion-helpers.js';
import { jsonResponse } from '../http-utils.js';

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
    throw err;
  }
}
