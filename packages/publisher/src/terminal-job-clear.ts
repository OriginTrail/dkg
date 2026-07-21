// #1837 — shared contract for the atomic by-exact-jobId TERMINAL clear, owned by NEITHER
// queue (lift nor promote) so a generic admin-clear result is not coupled to one
// implementation family's type module.

/**
 * Bounded outcome of a terminal clear, shared by the lift publisher and the SWM promote
 * queue. The control method owns every reason INCLUDING `malformed` (a corrupt persisted
 * payload — or an unsafe jobId — is only detectable inside the method, never at the HTTP
 * route). Never throws and never mutates on a reject. `already_absent` is a SUCCESS
 * (idempotent repeat), distinct from a rejection.
 */
export type TerminalJobClearOutcome =
  | { readonly outcome: 'cleared' }
  | { readonly outcome: 'already_absent' }
  | { readonly outcome: 'rejected'; readonly reason: 'nonterminal' | 'unknown' | 'malformed' };

// Producer grammar for a queue jobId (crypto.randomUUID(), or test 'job-N'): starts
// alphanumeric, then alnum/'.'/'_'/':'/'-', max 256. This is IRI-safe — it excludes every
// character that could break out of the `<…>` IRI in a control-plane SPARQL query (spaces,
// '<' '>' '"' '{' '}' '|' '^' '`', control chars). Mirrors the CLI's validatePromoteJobId.
const SAFE_CLEAR_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * True iff `jobId` is safe to interpolate into a control-plane SPARQL IRI. A by-id clear
 * MUST reject an unsafe jobId as `malformed` BEFORE building the query, so an
 * attacker-controlled jobId (from the clear-job HTTP body) yields a bounded reject rather
 * than a query syntax error / injection / 500.
 */
export function isSafeClearJobId(jobId: string): boolean {
  return jobId.length > 0 && jobId.length <= 256 && SAFE_CLEAR_JOB_ID.test(jobId);
}
