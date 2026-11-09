// SPDX-License-Identifier: Apache-2.0

/**
 * The write preflight's unresolved-write window (OT-RFC-73 S4a), kept in a leaf module so that the daemon can
 * read the default and the strict value without loading the agent. The rules around it, and the risk that
 * remains, are in the header of `dkg-agent-write-preflight.ts`.
 */

/**
 * How long sharing stays off after a policy write ended with an unknown outcome: two minutes. This is the
 * agent's own policy for the write preflight. It is a best-effort estimate of how long a remote store takes to
 * apply a write its caller stopped waiting for, not a bound any store promises, and it is not derived from a
 * storage deadline or timeout, so a change to a store's configuration leaves it where it is. The daemon can set
 * another with `DKG_WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS`.
 */
export const WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_MS = 120_000;

/**
 * The window value that means STRICT: after any unknown outcome of a policy write, sharing stays off for the
 * rest of the process, however late the write may land.
 */
export const WRITE_PREFLIGHT_UNRESOLVED_WRITE_WINDOW_STRICT = 0;
