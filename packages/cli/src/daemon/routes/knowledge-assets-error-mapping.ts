import { respondPromoteRecoveryError, type PromoteRecoveryContext } from './promote-recovery-response.js';
export { respondPromoteRecoveryError } from './promote-recovery-response.js';
import type { RequestContext } from './context.js';
import {
  AMBIGUOUS_ASSERTION_AUTHOR_CODE,
  ASSERTION_AUTHOR_NOT_RESIDENT_CODE,
  PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE,
} from '@origintrail-official/dkg-core';
import { PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED_CODE } from '@origintrail-official/dkg-publisher';
import {
  isPayloadTooLargeError,
  jsonResponse,
  oversizedRdfLiteralResponseBody,
  payloadTooLargeResponseBody,
  respondIfReconcileUnavailable,
  respondIfStoreUnavailable,
  respondIfChainRpcTransportError,
} from '../http-utils.js';

/**
 * GH#1778 — shared 409 mapping for the ambiguous-author VM-publish error, used
 * by both `vm/publish` and `vm/publish-async` so the `{ code, error, candidates }`
 * response shape cannot drift between the two routes. Returns `true` (and writes
 * the response) when it handled the error, `false` otherwise.
 */
export function respondAmbiguousAssertionAuthor(res: RequestContext["res"], e: any): boolean {
  if (e?.code !== AMBIGUOUS_ASSERTION_AUTHOR_CODE) return false;
  jsonResponse(res, 409, {
    code: AMBIGUOUS_ASSERTION_AUTHOR_CODE,
    error: e.message ?? String(e),
    candidates: e.candidates ?? [],
  });
  return true;
}

/**
 * GH#1786 — author-selection outcomes that are permanent, caller-actionable
 * state rather than server faults. Unmapped they would fall through to a generic
 * 500 on both publish lanes; they are answered here, and are matched BEFORE the
 * precondition / message-keyed branches so a future reword of either message
 * cannot be captured by those looser predicates.
 *
 *  - `ASSERTION_AUTHOR_NOT_RESIDENT`: the selected author has no finalized
 *    assertion at this coordinate. Echoes the resident `candidates` so the client
 *    can retry without a second round-trip.
 *  - `PUBLISH_AUTHOR_NOT_CUSTODIAL`: the selected author's KA needs an UPDATE,
 *    which the node cannot re-sign without that author's custodial key.
 */
export function respondAuthorSelectionError(res: RequestContext["res"], e: any): boolean {
  if (
    e?.code !== ASSERTION_AUTHOR_NOT_RESIDENT_CODE
    && e?.code !== PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE
  ) {
    return false;
  }
  jsonResponse(res, 409, {
    code: e.code,
    error: e.message ?? String(e),
    ...(e.candidates ? { candidates: e.candidates } : {}),
  });
  return true;
}

export function respondPublicationPricingPolicyError(res: RequestContext["res"], e: any): boolean {
  if (e?.code !== PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED_CODE) return false;
  jsonResponse(res, 409, {
    code: e.code,
    error: e.message ?? String(e),
  });
  return true;
}

const ASSERTION_CODE_STATUS: ReadonlyMap<string, number> = new Map([
  ['KA_ASSERTION_ALREADY_FINALIZED', 409],
  ['KA_SLOT_ALREADY_CLAIMED', 409],
  ['ASSERTION_EMPTY', 409],
  ['KA_WM_LIFECYCLE_REQUIRED', 409],
  ['KA_WM_LIFECYCLE_CORRUPT', 500],
]);

/** Shared typed lifecycle classification; callers retain route-specific recovery. */
export function respondAssertionCodeError(res: RequestContext["res"], e: any): boolean {
  const status = ASSERTION_CODE_STATUS.get(e?.code);
  if (status === undefined) return false;
  jsonResponse(res, status, { error: e.message, code: e.code });
  return true;
}

/**
 * Map typed WM/SWM preconditions and integrity failures before message fallbacks.
 * VM publishing keeps its own mapping so chain failures remain server errors.
 */
export function respondAssertionError(res: RequestContext["res"], e: any, context?: PromoteRecoveryContext): void {
  if (respondPromoteRecoveryError(res, e, context)) return;
  if (e?.code === "OVERSIZED_RDF_LITERAL") {
    jsonResponse(res, 400, oversizedRdfLiteralResponseBody(e));
    return;
  }
  if (isPayloadTooLargeError(e)) {
    jsonResponse(res, 413, payloadTooLargeResponseBody(e));
    return;
  }
  if (respondIfStoreUnavailable(res, e)) return;
  if (e?.name === "AssertionNotPersistedError" || e?.code === "ASSERTION_NOT_PERSISTED") {
    jsonResponse(res, 409, {
      error: e.message,
      code: "ASSERTION_NOT_PERSISTED",
      contextGraphId: e.contextGraphId,
      assertionGraph: e.assertionGraph,
      expectedTripleCount: e.expectedTripleCount,
    });
    return;
  }
  // Strict curator-ack gate (OT-RFC-49 curator-leader) on the WM→SWM promote
  // (swm/share). The curator (authoritative replica) did not confirm, so the
  // promote was aborted with WM left intact — surface a distinct, actionable
  // status instead of a 500. The client is TOLD, never silently led to success.
  if (e?.code === "CURATOR_UNCONFIRMED") {
    jsonResponse(res, 503, {
      error: e.message,
      code: "CURATOR_UNCONFIRMED",
      curatorDelivery: "unconfirmed",
      contextGraphId: e.contextGraphId,
    });
    return;
  }
  if (e?.code === "CURATOR_REJECTED") {
    jsonResponse(res, 409, {
      error: e.message,
      code: "CURATOR_REJECTED",
      curatorDelivery: "rejected",
      contextGraphId: e.contextGraphId,
    });
    return;
  }
  if (respondAssertionCodeError(res, e)) return;
  // KA-number-floor reconcile couldn't reach the chain (e.g. a rate-limited RPC
  // 429'd the one-time-per-author read) -> retryable 503, not 500.
  if (respondIfReconcileUnavailable(res, e)) return;
  // Transient chain-RPC transport failure (all endpoints exhausted / receipt
  // lookup failed / timeout) -> retryable 503/504, keyed on err.code so a
  // genuine on-chain revert (no transport code) still falls through to the
  // 4xx/500 mapping below. Code-keyed check precedes the message-keyed 400
  // branch so an exhaustion message that happens to contain "not found"
  // (e.g. "header not found") is not mis-mapped to a 400.
  if (respondIfChainRpcTransportError(res, e)) return;
  const msg = e?.message ?? String(e);
  if (
    e?.name === "ReservedNamespaceError" ||
    msg.includes("not found") ||
    msg.includes("Invalid") ||
    msg.includes("Unsafe") ||
    msg.includes("reserved namespace")
  ) {
    jsonResponse(res, 400, { error: msg });
    return;
  }
  jsonResponse(res, 500, { error: msg });
}
