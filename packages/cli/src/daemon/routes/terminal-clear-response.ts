// daemon/routes/terminal-clear-response.ts
//
// #1837 — single source for the TerminalJobClearOutcome → HTTP projection, shared by the
// publisher (`POST /api/publisher/clear-job`) and SWM share-job
// (`POST /api/knowledge-assets/swm/share-jobs/:jobId/clear`) clear routes so the response
// contract cannot drift. This is route-owned policy (both clear routes are the only
// callers), so it lives beside the routes rather than in the generic `http-utils.ts`
// bucket, which stays focused on protocol-level helpers (JSON responses, body parsing).
//
// Mapping: `cleared` / `already_absent` are SUCCESS (200, idempotent — NOT 404);
// `rejected(malformed)` is a client input error (400); `rejected(nonterminal|pending_transaction|unknown)`
// is a server-side state condition (409). #3573 — `pending_transaction` (publish jobs only) also says
// how the job can still be cleared, and what to check first.

import type { ServerResponse } from "node:http";
import type { TerminalJobClearOutcome } from "@origintrail-official/dkg-publisher";
import { jsonResponse } from "../http-utils.js";

const PENDING_TRANSACTION_CLEAR =
  "This job may have sent a transaction. Check it first: once the job is cleared, a re-submit starts a new job, "
  + 'which can publish the Knowledge Asset a second time. To clear it anyway, send "allowPendingTransaction": true '
  + "with the node-operator token, or as the agent that enqueued the job.";

export function respondTerminalClearOutcome(
  res: ServerResponse,
  outcome: TerminalJobClearOutcome,
  jobId: string,
): void {
  if (outcome.outcome === "cleared" || outcome.outcome === "already_absent") {
    jsonResponse(res, 200, { ...outcome, jobId });
    return;
  }
  jsonResponse(res, outcome.reason === "malformed" ? 400 : 409, {
    ...outcome,
    jobId,
    ...(outcome.reason === "pending_transaction" ? { error: PENDING_TRANSACTION_CLEAR } : {}),
  });
}
