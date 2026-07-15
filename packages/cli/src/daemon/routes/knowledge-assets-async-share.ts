// daemon/routes/knowledge-assets-async-share.ts
//
// Async SWM-share job-management routes for the GitHub-shaped Knowledge Asset
// HTTP surface. These are FAITHFUL ports of the four legacy `/api/assertion/
// promote-async*` job routes in `daemon/routes/assertion.ts` (RFC:
// docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md). The SWM "share" is the WM→SWM
// promote; enqueue is handled alongside the synchronous share policy in
// `knowledge-assets.ts`, while this module owns the `share-jobs` collection:
//
//   GET    /api/knowledge-assets/swm/share-jobs
//        ↔ GET    /api/assertion/promote-async
//   GET    /api/knowledge-assets/swm/share-jobs/:jobId
//        ↔ GET    /api/assertion/promote-async/:jobId
//   DELETE /api/knowledge-assets/swm/share-jobs/:jobId
//        ↔ DELETE /api/assertion/promote-async/:jobId
//   POST   /api/knowledge-assets/swm/share-jobs/:jobId/recover
//        ↔ POST   /api/assertion/promote-async/:jobId/recover
//
// Validation, 503-when-worker-unavailable, jobId decode, state filtering,
// error mapping, and response shapes are identical to the legacy handlers.
// Shared logic lives in `./shared-assertion-helpers.js`.

import type { RequestContext } from "./context.js";
import { jsonResponse } from "../http-utils.js";
import {
  PROMOTE_JOB_STATES,
  type PromoteJobState,
} from "@origintrail-official/dkg-publisher";
import {
  promoteJobToView,
  asyncPromoteUnavailable,
} from "./shared-assertion-helpers.js";

// ── GET /api/knowledge-assets/swm/share-jobs ──────────────────────────────────
//   ?contextGraphId=<cg>&state=queued,running,...&limit=<n>
//
// Faithful port of GET /api/assertion/promote-async. List jobs filtered by
// contextGraphId / state.
export async function handleKaShareJobsList(ctx: RequestContext): Promise<void> {
  const { res, agent, url } = ctx;
  if (asyncPromoteUnavailable(res)) return;
  const stateParam = url.searchParams.get("state");
  const requestedStates = stateParam ? stateParam.split(",").map((s) => s.trim()) : undefined;
  if (
    requestedStates &&
    (requestedStates.length === 0 ||
      requestedStates.some((s) => !(PROMOTE_JOB_STATES as readonly string[]).includes(s)))
  ) {
    return jsonResponse(res, 400, {
      error: `Invalid state filter: ${stateParam}. Allowed: ${PROMOTE_JOB_STATES.join(",")}`,
    });
  }
  const stateFilter = requestedStates as PromoteJobState[] | undefined;
  const contextGraphId = url.searchParams.get("contextGraphId") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  if (limitParam !== null && !/^[1-9]\d*$/.test(limitParam)) {
    return jsonResponse(res, 400, {
      error: "limit must be a positive integer ≤ 1000",
    });
  }
  const limit = limitParam !== null ? Number.parseInt(limitParam, 10) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0 || limit > 1000)) {
    return jsonResponse(res, 400, {
      error: "limit must be a positive integer ≤ 1000",
    });
  }
  const jobs = await agent.assertion.listPromoteAsyncJobs({
    state: stateFilter,
    contextGraphId,
    limit,
  });
  return jsonResponse(res, 200, { jobs: jobs.map(promoteJobToView) });
}

// ── GET /api/knowledge-assets/swm/share-jobs/:jobId ───────────────────────────
//
// Faithful port of GET /api/assertion/promote-async/:jobId. The caller passes
// the already url-decoded + validated `jobId` (the KA dispatch decodes it via
// `decodePromoteJobId`, exactly as the legacy route did inline).
export async function handleKaShareJobStatus(ctx: RequestContext, jobId: string): Promise<void> {
  const { res, agent } = ctx;
  if (asyncPromoteUnavailable(res)) return;
  const job = await agent.assertion.getPromoteAsyncStatus(jobId);
  if (!job) {
    return jsonResponse(res, 404, { error: `Promote job not found: ${jobId}` });
  }
  return jsonResponse(res, 200, promoteJobToView(job));
}

// ── DELETE /api/knowledge-assets/swm/share-jobs/:jobId ────────────────────────
//
// Faithful port of DELETE /api/assertion/promote-async/:jobId — cancel a
// queued/failed_retrying job. The caller passes the already url-decoded +
// validated `jobId`.
export async function handleKaShareJobCancel(ctx: RequestContext, jobId: string): Promise<void> {
  const { res, agent } = ctx;
  try {
    await agent.assertion.cancelPromoteAsync(jobId);
    const job = await agent.assertion.getPromoteAsyncStatus(jobId);
    return jsonResponse(res, 200, { jobId, state: job?.state ?? "failed" });
  } catch (err: any) {
    if (err.message?.includes("not found")) {
      return jsonResponse(res, 404, { error: err.message });
    }
    // "Cannot cancel job in state 'running'" etc.
    if (err.message?.includes("Cannot cancel")) {
      return jsonResponse(res, 409, { error: err.message });
    }
    throw err;
  }
}

// ── POST /api/knowledge-assets/swm/share-jobs/:jobId/recover ──────────────────
//
// Faithful port of POST /api/assertion/promote-async/:jobId/recover — requeue
// a terminal-failed job. The caller passes the already url-decoded + validated
// `jobId`.
export async function handleKaShareJobRecover(ctx: RequestContext, jobId: string): Promise<void> {
  const { res, agent } = ctx;
  try {
    await agent.assertion.recoverPromoteAsync(jobId);
    const job = await agent.assertion.getPromoteAsyncStatus(jobId);
    return jsonResponse(res, 200, { jobId, state: job?.state ?? "queued" });
  } catch (err: any) {
    if (err.message?.includes("not found")) {
      return jsonResponse(res, 404, { error: err.message });
    }
    if (err.message?.includes("Cannot recover")) {
      return jsonResponse(res, 409, { error: err.message });
    }
    throw err;
  }
}
