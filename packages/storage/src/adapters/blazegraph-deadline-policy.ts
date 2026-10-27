// SPDX-License-Identifier: Apache-2.0

/**
 * The Blazegraph adapter's deadline policy, kept apart from the adapter so that a caller outside the storage
 * package can state its own safety margin from the same numbers the adapter puts on the wire.
 */

export const DEFAULT_BLAZEGRAPH_OPERATION_TIMEOUT_MS = 30_000;

/**
 * Multiplier applied to the client deadline to derive the server-side bound.
 *
 * This is deliberately > 1: the server deadline must be WIDER than the
 * client's, never tighter. Two reasons, and the second is a correctness trap:
 *
 * 1. The problem being solved is *abandoned* work. When the client aborts at
 *    its deadline the HTTP connection goes away but Blazegraph keeps executing
 *    the query — observed on mainnet running 10-32+ minutes past a 30s client
 *    abort, with `queryErrorCount = 0` across 20,953 queries confirming the
 *    server never cancelled anything. A handful of these saturate a core. Any
 *    finite server bound fixes that; it does not need to be tight.
 *
 * 2. A tight bound introduces silent data loss. Blazegraph commits `200 OK`
 *    and begins streaming before the deadline fires, then appends its error
 *    into the already-committed body. A CONSTRUCT killed mid-stream therefore
 *    returns a SHORT BUT STRUCTURALLY VALID n-quads document. Since the client
 *    is still reading at that point, it parses the truncated result as a
 *    complete one — a sync page that looks whole and is not. Keeping the
 *    server bound comfortably above the client deadline means the client
 *    always aborts first, so no caller is ever parsing a truncated body.
 *    ({@link parseBlazegraphConstructNQuads} is the belt-and-braces guard for the
 *    residual case.)
 *
 * With the 30s default this yields a 120s server bound: orphan lifetime drops
 * from unbounded to at most 2 minutes, while the truncation path stays
 * unreachable.
 */
const SERVER_QUERY_DEADLINE_FACTOR = 4;

/**
 * The longest a Blazegraph server keeps working on a request whose caller has stopped waiting: the
 * server-side deadline the adapter sends, derived from the client deadline it was given (the 30 s default
 * unless stated). The adapter sends exactly this value with every read, and a caller that has to reason about
 * a write it abandoned (the agent's write preflight) reads the bound from here, so a change to the deadline
 * policy moves both together. With the default client deadline this is 120 s.
 */
export function maxAbandonedStoreOperationMs(
  operationTimeoutMs: number = DEFAULT_BLAZEGRAPH_OPERATION_TIMEOUT_MS,
): number {
  return operationTimeoutMs * SERVER_QUERY_DEADLINE_FACTOR;
}
