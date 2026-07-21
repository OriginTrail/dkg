// Neutral job-id grammar contract, shared by BOTH the by-jobId terminal-clear guard
// (`isSafeJobId`, used by the lift publisher and the promote queue) AND the CLI promote
// route validator (`validatePromoteJobId`). It is NOT clear-specific — status / cancel /
// recover / clear all accept the same job-id shape — so it lives in its own module rather
// than being named as terminal-clear policy, and a change here provably applies to every
// promote route + control-plane operation at once.

// Producer grammar for a queue jobId (crypto.randomUUID(), or test 'job-N'): starts
// alphanumeric, then alnum / '.' / '_' / ':' / '-'. IRI-safe — it excludes every character
// that could break out of the `<…>` IRI in a control-plane SPARQL query (spaces, '<' '>'
// '"' '{' '}' '|' '^' '`', control chars).
export const SAFE_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const SAFE_JOB_ID_MAX_LENGTH = 256;

/**
 * True iff `jobId` is safe to interpolate into a control-plane SPARQL IRI. A by-jobId
 * operation MUST reject an unsafe jobId BEFORE building the query, so an attacker-controlled
 * jobId (e.g. from an HTTP body) yields a bounded reject rather than a query syntax error /
 * injection / 500.
 */
export function isSafeJobId(jobId: string): boolean {
  return jobId.length > 0 && jobId.length <= SAFE_JOB_ID_MAX_LENGTH && SAFE_JOB_ID_PATTERN.test(jobId);
}
