/**
 * Query-error classification policy for `/api/query`.
 *
 * Extracted from routes/query.ts (PR #2330 review): that file is a ~1.4k-line
 * mixed-purpose route, and the policy had grown into two cooperating exported
 * helpers with an implicit ordering dependency between them. One classifier
 * owns it now — typed errors are a terminal branch, legacy message matching
 * applies only to untyped ones — so there is a single place to add a rule and
 * no way to place it wrongly.
 */
import { isSparqlHttpResponseError } from "@origintrail-official/dkg-storage";

/**
 * Upstream statuses that mean "the SPARQL the caller sent is malformed".
 *
 * Deliberately NOT every 4xx. A configured store can answer 401/403 for stale
 * daemon credentials, 404 for a misconfigured endpoint, or 429 when throttling
 * us — those are server/integration faults, and reporting them as 400 would
 * tell the caller their query is invalid and suppress the retry or operator
 * remediation that would actually fix it.
 */
const MALFORMED_QUERY_STATUSES = new Set([400, 422]);

/**
 * Legacy message families, for errors with no typed carrier.
 *
 * GH#1758 was a silent re-regression of #889 precisely because this condition
 * lived inline inside a catch block, so nothing could assert on it.
 */
export function isClientQueryError(msg: string): boolean {
  return (
    
        msg.startsWith("SPARQL rejected:") ||
        msg.startsWith("Parse error") ||
        // #889: oxigraph surfaces SPARQL syntax errors as
        // `error at <line>:<col>: expected one of ...` (e.g. a missing
        // closing brace or an incomplete triple). These are client input
        // errors, not server faults — classify them as 400 to match the
        // existing `SPARQL rejected:` / `must start with ...` handling
        // instead of letting them fall through to a 500.
        /^error at \d+:\d+:/.test(msg) ||
        /must start with (SELECT|CONSTRUCT|ASK|DESCRIBE)/i.test(msg) ||
        msg.includes("was removed in V10") ||
        msg.includes("agentAddress is required") ||
        msg.includes("requires a contextGraphId") ||
        msg.includes("cannot be combined with") ||
        msg.startsWith("Scoped query violation:") ||
        // A-1 review: DKGAgent.query throws these when the caller sends
        // a non-string `agentAddress` / `callerAgentAddress` in the
        // body. Classify as 400 so malformed input is a clean client
        // error instead of a 500.
        msg.startsWith("query: 'agentAddress' must be a string") ||
        msg.startsWith("query: 'callerAgentAddress' must be a string") ||
        // P-13 review: `resolveViewGraphs` validates `minTrust` now,
        // so direct callers that forward a string / out-of-range
        // value get a 400 instead of a 500.
        msg.startsWith("Invalid minTrust")
  );
}

/**
 * Should `/api/query` answer 400 for this thrown error?
 *
 * `true` renders a 400; `false` rethrows as a server fault. A typed SPARQL
 * HTTP response is terminal — its status decides, and message matching is not
 * consulted, so a store rejecting US can never be reported as the caller's bad
 * query.
 */
export function isClientQueryFailure(err: unknown): boolean {
  if (isSparqlHttpResponseError(err)) {
    return MALFORMED_QUERY_STATUSES.has(err.status);
  }
  const msg = (err as { message?: unknown })?.message;
  return typeof msg === "string" && isClientQueryError(msg);
}
