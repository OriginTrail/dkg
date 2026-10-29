import { CATALOG_PUBLICATION_ADMISSION_CODE } from '@origintrail-official/dkg-agent';
import { classifyPromoteAdmissionError } from './promote-admission-response.js';
import type { AssertionFailureResponse } from './assertion-failure-response.js';
import { classifyPromoteRecoveryError, type PromoteRecoveryContext } from './promote-recovery-response.js';
export { respondPromoteRecoveryError } from './promote-recovery-response.js';
import type { RequestContext } from './context.js';
import {
  AMBIGUOUS_ASSERTION_AUTHOR_CODE,
  ASSERTION_AUTHOR_NOT_RESIDENT_CODE,
  ASYNC_PUBLISH_FOREIGN_AUTHOR_CODE,
  PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE,
} from '@origintrail-official/dkg-core';
import { PUBLISH_PRICING_POLICY_UPDATE_UNSUPPORTED_CODE, SUB_GRAPH_NOT_FOUND_CODE } from '@origintrail-official/dkg-publisher';
import {
  isPayloadTooLargeError,
  jsonResponse,
  oversizedRdfLiteralResponseBody,
  payloadTooLargeResponseBody,
  classifyReconcileUnavailable,
  classifyStoreUnavailable,
  classifyChainRpcTransportStatus,
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
 *  - `ASYNC_PUBLISH_FOREIGN_AUTHOR` (GH#3294): the queued lane cannot take
 *    another node's KA; the synchronous `vm/publish` can.
 */
export function respondAuthorSelectionError(res: RequestContext["res"], e: any): boolean {
  if (
    e?.code !== ASSERTION_AUTHOR_NOT_RESIDENT_CODE
    && e?.code !== PUBLISH_AUTHOR_NOT_CUSTODIAL_CODE
    && e?.code !== ASYNC_PUBLISH_FOREIGN_AUTHOR_CODE
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
  ['KA_PROMOTE_ACK_REQUIREMENT_CONFLICT', 409],
  ['KA_SHARE_AUTHOR_MISMATCH', 409],
  ['KA_SHARE_INVENTORY_SIGNER_UNAVAILABLE', 422],
  ['KA_SLOT_ALREADY_CLAIMED', 409],
  ['KA_RESERVED_ID_MISMATCH', 409],
  ['ASSERTION_EMPTY', 409],
  ['KA_WM_LIFECYCLE_REQUIRED', 409],
  ['KA_WM_LIFECYCLE_CORRUPT', 500],
  // A write into a sub-graph that neither this node nor the graph's peers it asked hold (#3293).
  [SUB_GRAPH_NOT_FOUND_CODE, 400],
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
export function classifyAssertionError(e: any, context?: PromoteRecoveryContext): AssertionFailureResponse {
  const admission = classifyPromoteAdmissionError(e);
  if (admission) return admission;
  const promote = classifyPromoteRecoveryError(e, context);
  if (promote) return promote;
  if (e?.code === "OVERSIZED_RDF_LITERAL") return { status: 400, body: oversizedRdfLiteralResponseBody(e) };
  if (isPayloadTooLargeError(e)) return { status: 413, body: payloadTooLargeResponseBody(e) };
  const store = classifyStoreUnavailable(e);
  if (store) return { status: 503, partialDisposition: 'unavailable', body: store.body, headers: { 'Retry-After': '1' } };
  if (e?.name === "AssertionNotPersistedError" || e?.code === "ASSERTION_NOT_PERSISTED") {
    return { status: 409, body: {
      error: e.message, code: "ASSERTION_NOT_PERSISTED", contextGraphId: e.contextGraphId,
      assertionGraph: e.assertionGraph, expectedTripleCount: e.expectedTripleCount,
    } };
  }
  if (e?.code === "CURATOR_UNCONFIRMED" || e?.code === "CURATOR_REJECTED") {
    const unconfirmed = e.code === 'CURATOR_UNCONFIRMED';
    return { status: unconfirmed ? 503 : 409, body: { error: e.message, code: e.code,
      curatorDelivery: unconfirmed ? 'unconfirmed' : 'rejected', contextGraphId: e.contextGraphId } };
  }
  const status = ASSERTION_CODE_STATUS.get(e?.code);
  if (status !== undefined) return { status, body: { error: e.message, code: e.code } };
  const reconcile = classifyReconcileUnavailable(e);
  if (reconcile) return { status: 503, body: reconcile };
  const transport = classifyChainRpcTransportStatus(e);
  if (transport) return { ...transport, ...(transport.body.code === 'RPC_REQUEST_GOVERNOR_QUEUE_FULL'
    ? { headers: { 'Retry-After': '1' } } : {}) };
  const msg = e?.message ?? String(e);
  const invalid = e?.name === "ReservedNamespaceError" || msg.includes("not found")
    || msg.includes("Invalid") || msg.includes("Unsafe") || msg.includes("reserved namespace");
  return { status: invalid ? 400 : 500, body: { error: msg } };
}

export function respondAssertionError(res: RequestContext["res"], e: any, context?: PromoteRecoveryContext): void {
  const failure = classifyAssertionError(e, context);
  jsonResponse(res, failure.status, failure.body, undefined, failure.headers);
}

/** Only pre-publication immutable-identity failures receive this client classification. */
export function respondCatalogPublicationAdmissionError(res: RequestContext['res'], error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== CATALOG_PUBLICATION_ADMISSION_CODE) return false;
  jsonResponse(res, 400, { code: CATALOG_PUBLICATION_ADMISSION_CODE, error: error instanceof Error ? error.message : String(error) });
  return true;
}
