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
 * Recognised structurally rather than by importing `@origintrail-official/dkg-query`.
 * The cli package does not depend on it directly (the error arrives through the
 * agent), and adding a dependency would put this change behind the CODEOWNERS
 * gate on the per-package manifests for no behavioural gain. Source of truth for
 * the constant is `packages/query/src/caller-sparql-error.ts`.
 */
const CALLER_SPARQL_REJECTED_CODE = "CALLER_SPARQL_REJECTED";

function isCallerSparqlRejected(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const c = err as { code?: unknown; status?: unknown; message?: unknown };
  return (
    c.code === CALLER_SPARQL_REJECTED_CODE &&
    typeof c.status === "number" &&
    Number.isFinite(c.status) &&
    typeof c.message === "string"
  );
}

/**
 * Legacy message families, for errors with no typed carrier.
 *
 * GH#1758 was a silent re-regression of #889 precisely because this condition
 * lived inline inside a catch block, so nothing could assert on it.
 */
function isLegacyClientQueryMessage(msg: string): boolean {
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
 * `true` renders a 400; `false` rethrows as a server fault.
 *
 * A bare upstream status is NOT sufficient (PR #2330 review): one request also
 * runs engine-generated queries for access control, graph resolution and
 * metadata scans, and a store rejecting one of those with 400 is an
 * integration fault, not a malformed caller query. The query engine marks the
 * single store call that carried caller-supplied SPARQL; only that marker — or
 * a legacy message family with no typed carrier — yields a 400.
 *
 * This is the sole exported classifier. The legacy message matcher stays
 * private so the provenance-first rule cannot be bypassed.
 */
export function isClientQueryFailure(err: unknown): boolean {
  // 1. Provenance wins: the engine marked this as the caller's own SPARQL.
  if (isCallerSparqlRejected(err)) return true;

  // 2. A TYPED store error that was NOT marked is terminal — it came from an
  //    engine-generated query, so it is a server fault no matter what its
  //    rendered message happens to look like. Without this, a store rejection
  //    whose body contained e.g. "Query must start with SELECT" would fall
  //    through to the legacy families below and be reported as the caller's
  //    fault, defeating the provenance rule (PR #2330 review).
  if (isSparqlHttpResponseError(err)) return false;

  // 3. Legacy families, for errors with no typed carrier at all.
  const msg = (err as { message?: unknown })?.message;
  return typeof msg === "string" && isLegacyClientQueryMessage(msg);
}
