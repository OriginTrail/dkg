/**
 * How the UI checks on the node. The API client and the status display both
 * use this; it holds no wording or presentation.
 */

/** How often the UI checks the node. A check also times out after this long. */
export const NODE_STATUS_POLL_MS = 10_000;

/** Failed status checks in a row before the status says Unavailable. */
export const NODE_UNAVAILABLE_AFTER_FAILURES = 3;

/** A 401 comes from a running node that wants a token: not a failed check, and it clears the count. */
export function isNodeStatusFailure(error: unknown): boolean {
  return (error as { status?: unknown } | null | undefined)?.status !== 401;
}
