import type { RequestContext } from './context.js';
import { handleShareReconciliation } from './share-reconciliation.js';
import { decodePromoteJobId } from './shared-assertion-helpers.js';
import { handleKaShareJobsList, handleKaShareJobStatus, handleKaShareJobCancel,
  handleKaShareJobClear, handleKaShareJobRecover } from './knowledge-assets-async-share.js';

/** Collection reads must precede generic asset names and job-ID decoding. */
export async function handleShareJobCollection(ctx: RequestContext): Promise<boolean> {
  const { path, res } = ctx, method = ctx.req.method ?? "GET";
  const SHARE_JOBS_PREFIX = '/api/knowledge-assets/swm/share-jobs';
  if (path === SHARE_JOBS_PREFIX || path.startsWith(`${SHARE_JOBS_PREFIX}/`)) {
    if (method === "GET" && path === `${SHARE_JOBS_PREFIX}/reconcile`) { await handleShareReconciliation(ctx); return true; }
    // GET /api/knowledge-assets/swm/share-jobs — list
    if (method === "GET" && path === SHARE_JOBS_PREFIX) {
      await handleKaShareJobsList(ctx); return true;
    }
    // POST /api/knowledge-assets/swm/share-jobs/:jobId/recover — recover (#5)
    if (
      method === "POST" &&
      path.startsWith(`${SHARE_JOBS_PREFIX}/`) &&
      path.endsWith("/recover")
    ) {
      const jobId = decodePromoteJobId(
        path.slice(`${SHARE_JOBS_PREFIX}/`.length, -"/recover".length),
        res,
      );
      if (jobId === null) return true;
      await handleKaShareJobRecover(ctx, jobId); return true;
    }
    // POST /api/knowledge-assets/swm/share-jobs/:jobId/clear — #1837 atomic terminal
    // record removal (idempotent). DISTINCT from the DELETE cancellation below (which
    // rewrites a queued job to failed+cancelled and RETAINS the row).
    if (
      method === "POST" &&
      path.startsWith(`${SHARE_JOBS_PREFIX}/`) &&
      path.endsWith("/clear")
    ) {
      const jobId = decodePromoteJobId(
        path.slice(`${SHARE_JOBS_PREFIX}/`.length, -"/clear".length),
        res,
      );
      if (jobId === null) return true;
      await handleKaShareJobClear(ctx, jobId); return true;
    }
    // GET /api/knowledge-assets/swm/share-jobs/:jobId — status (#3)
    if (
      method === "GET" &&
      path.startsWith(`${SHARE_JOBS_PREFIX}/`) &&
      !path.endsWith("/recover")
    ) {
      const jobId = decodePromoteJobId(path.slice(`${SHARE_JOBS_PREFIX}/`.length), res);
      if (jobId === null) return true;
      await handleKaShareJobStatus(ctx, jobId); return true;
    }
    // DELETE /api/knowledge-assets/swm/share-jobs/:jobId — cancel (#4)
    if (method === "DELETE" && path.startsWith(`${SHARE_JOBS_PREFIX}/`)) {
      const jobId = decodePromoteJobId(path.slice(`${SHARE_JOBS_PREFIX}/`.length), res);
      if (jobId === null) return true;
      await handleKaShareJobCancel(ctx, jobId); return true;
    }
  }

  return false;
}
