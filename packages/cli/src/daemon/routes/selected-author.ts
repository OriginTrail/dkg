// SPDX-License-Identifier: Apache-2.0
import type { RequestContext } from './context.js';
import { jsonResponse } from '../http-utils.js';

export const SELECTED_AUTHOR_FIELD = "selectedAuthorAgentAddress";

/**
 * GH#1786 — read + validate the resident-author selector. Distinct from the
 * rejected `authorAgentAddress` (which would OVERRIDE authorship — the seal
 * already encodes the author): this only SELECTS among authors who already have
 * a finalized assertion at this coordinate, so a client can act on a
 * 409 `AMBIGUOUS_ASSERTION_AUTHOR`. Returns `{ ok: false }` after having written
 * a 400 (caller must return).
 */
export function resolveSelectedAuthorAgentAddress(
  ctx: RequestContext,
  source: Record<string, unknown>,
): { ok: true; value?: string } | { ok: false } {
  const raw = source[SELECTED_AUTHOR_FIELD];
  // Only `undefined` counts as absent. A PRESENT `null` (a common client
  // serialization of "nothing selected") must fail closed like any other malformed
  // value — treating it as absent would fall back to normal author resolution and
  // could publish a different author with 200 instead of a request-shape error.
  if (raw === undefined) return { ok: true };
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    jsonResponse(ctx.res, 400, {
      error: `"${SELECTED_AUTHOR_FIELD}" must be a 0x-prefixed 20-byte EVM address`,
    });
    return { ok: false };
  }
  return { ok: true, value: raw };
}
