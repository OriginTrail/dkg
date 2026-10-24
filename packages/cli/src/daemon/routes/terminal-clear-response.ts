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
// `rejected(malformed)` is a client input error (400); `rejected(nonterminal|unknown)` is a
// server-side state condition (409).

import type { ServerResponse } from "node:http";
import type { TerminalJobClearOutcome } from "@origintrail-official/dkg-publisher";
import { jsonResponse } from "../http-utils.js";

export function respondTerminalClearOutcome(
  res: ServerResponse,
  outcome: TerminalJobClearOutcome,
  jobId: string,
): void {
  if (outcome.outcome === "cleared" || outcome.outcome === "already_absent") {
    jsonResponse(res, 200, { ...outcome, jobId });
    return;
  }
  jsonResponse(res, outcome.reason === "malformed" ? 400 : 409, { ...outcome, jobId });
}
