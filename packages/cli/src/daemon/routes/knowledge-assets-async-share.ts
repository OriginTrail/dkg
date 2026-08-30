// daemon/routes/knowledge-assets-async-share.ts
//
// Async SWM-share queue routes for the GitHub-shaped Knowledge Asset HTTP
// surface. These are FAITHFUL ports of the five legacy `/api/assertion/
// promote-async*` routes in `daemon/routes/assertion.ts` (RFC:
// docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md). The SWM "share" is the WM→SWM
// promote, so the async variant is exposed as `share-async` (enqueue) and the
// jobs collection as `share-jobs`:
//
//   POST   /api/knowledge-assets/:name/swm/share-async
//        ↔ POST   /api/assertion/:name/promote-async
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
import { respondTerminalClearOutcome } from "./terminal-clear-response.js";
import {
  jsonResponse,
  readBody,
  safeParseJson,
  validateEntities,
  validateOptionalSubGraphName,
  resolveRequiredWriteContextGraphId,
  SMALL_BODY_BYTES,
} from "../http-utils.js";
import {
  PROMOTE_JOB_STATES,
  PromoteJobConflictError,
  type PromoteJobState,
} from "@origintrail-official/dkg-publisher";
import { validateAssertionName } from "@origintrail-official/dkg-core";
import {
  promoteJobToView,
  asyncPromoteUnavailable,
  scopedTokenPromoteLane,
} from "./shared-assertion-helpers.js";

// ── POST /api/knowledge-assets/:name/swm/share-async ──────────────────────────
//   { contextGraphId, entities?, subGraphName? }
//
// Faithful port of POST /api/assertion/:name/promote-async. The caller passes
// the already-decoded `:name` segment (the KA dispatch decodes/validates names
// up front, exactly as the legacy route did via `safeDecodeURIComponent` +
// `validateAssertionName`); we re-validate the name here so this standalone
// handler matches the legacy contract byte-for-byte regardless of entry point.
// Async share uses the named Knowledge Asset lifecycle: finalization allocates
// the UAL-bound KA id, canonicalizes the exact graph, and persists the seal
// before the graph-scoped queue job can be accepted. (The live dispatch in
// `knowledge-assets.ts` already
// serves swm/share-async inline; this standalone faithful-port handler is kept in
// lockstep so either entry point behaves identically.)
export async function handleKaShareAsyncEnqueue(ctx: RequestContext, name: string): Promise<void> {
  const { req, res, agent, requestPrincipal } = ctx;
  const writePreflightCallerAgentAddress = requestPrincipal.kind === 'agent'
    ? requestPrincipal.agentAddress
    : undefined;
  const writePreflightContextGraphOpts = {
    callerAgentAddress: writePreflightCallerAgentAddress,
    allowLocalExactFallback: !writePreflightCallerAgentAddress,
  };

  const nameVal = validateAssertionName(name);
  if (!nameVal.valid)
    return jsonResponse(res, 400, {
      error: `Invalid assertion name: ${nameVal.reason}`,
    });
  if (asyncPromoteUnavailable(res)) return;
  const body = await readBody(req, SMALL_BODY_BYTES);
  const parsed = safeParseJson(body, res);
  if (!parsed) return;
  const { contextGraphId, entities, subGraphName } = parsed;
  const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
    agent,
    contextGraphId,
    res,
    writePreflightContextGraphOpts,
  );
  if (!resolvedContextGraphId) return;
  if (!validateEntities(entities, res)) return;
  if (!validateOptionalSubGraphName(subGraphName, res)) return;
  // #1116 (round 5) — the sync swm/share validates `skipSeal` as a strict
  // boolean; the async queue ALWAYS seals (the safe default) and cannot carry
  // skipSeal through the job, so it was silently dropped — a confusing footgun
  // (a caller asking to skip sealing got a sealed share). Match the sync route's
  // strict-boolean validation, and reject a truthy boolean outright rather than
  // honoring it differently than requested.
  if (parsed?.skipSeal !== undefined) {
    if (typeof parsed.skipSeal !== "boolean") {
      return jsonResponse(res, 400, {
        error: '"skipSeal" must be a boolean when supplied',
      });
    }
    if (parsed.skipSeal === true) {
      return jsonResponse(res, 400, {
        error:
          "skipSeal is not supported for async share; use swm/share (the synchronous route) to share without sealing",
      });
    }
  }
  try {
    const result = await agent.assertion.promoteAsync(
      resolvedContextGraphId,
      name,
      {
        entities: entities ?? "all",
        subGraphName,
        ...scopedTokenPromoteLane(writePreflightCallerAgentAddress),
      },
    );
    return jsonResponse(res, 200, {
      jobId: result.jobId,
      state: "queued",
    });
  } catch (err: any) {
    if (err instanceof PromoteJobConflictError) {
      return jsonResponse(res, 409, {
        error: err.message,
        existingJobId: err.existingJobId,
      });
    }
    if (
      err.message?.includes("required") ||
      err.message?.includes("Invalid") ||
      err.message?.includes("must be")
    ) {
      return jsonResponse(res, 400, { error: err.message });
    }
    throw err;
  }
}

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

// ── POST /api/knowledge-assets/swm/share-jobs/:jobId/clear ────────────────────
//
// #1837 — atomic by-exact-jobId TERMINAL record removal. DISTINCT from the DELETE
// cancellation above (which rewrites a queued job to failed+cancelled and RETAINS the
// row): this REMOVES a native-terminal (succeeded|failed) job record and is idempotent
// (already_absent = 200, not 404). The caller passes the already url-decoded jobId.
export async function handleKaShareJobClear(ctx: RequestContext, jobId: string): Promise<void> {
  const { res, agent } = ctx;
  return respondTerminalClearOutcome(res, await agent.assertion.clearPromoteAsync(jobId), jobId);
}
