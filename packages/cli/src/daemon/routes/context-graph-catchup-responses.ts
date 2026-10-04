import type { ServerResponse } from 'node:http';
import { recordCatchupRequest } from '../catchup-telemetry.js';
import { jsonResponse } from '../http-utils.js';

/**
 * Refuse to mint a new catch-up job because the daemon is shutting down.
 *
 * Shaped after `respondIfStoreUnavailable` — retryable 503 plus `Retry-After`
 * — because that is what this is: the request is fine, the node just cannot
 * take on new work it will never drain. Returned from BOTH mint sites, which
 * is why I7's `result` vocabulary needed a distinct value; a 503 that clamped
 * to `unspecified` would hide the one route outcome shutdown introduces.
 */
export function catchupShuttingDownResponse(res: ServerResponse, includeSharedMemory: boolean): void {
  recordCatchupRequest('shutting_down', includeSharedMemory);
  return jsonResponse(
    res,
    503,
    {
      error:
        'Node is shutting down and is no longer accepting catch-up jobs; retry once it is back up.',
      code: 'CATCHUP_SHUTTING_DOWN',
      retryable: true,
    },
    undefined,
    { 'Retry-After': '5' },
  );
}

/** Fail closed without misreporting a transient authority outage as a denial. */
export function catchupAuthorityUnavailableResponse(
  res: ServerResponse,
  includeSharedMemory: boolean,
): void {
  recordCatchupRequest('authority_unavailable', includeSharedMemory);
  return authorityUnavailableResponse(res);
}

/** The retryable 503 for an admission read that could not be completed. */
export function authorityUnavailableResponse(res: ServerResponse): void {
  return jsonResponse(
    res,
    503,
    {
      error: 'Context Graph read authority is temporarily unavailable; retry once chain and metadata access recover.',
      code: 'CONTEXT_GRAPH_AUTHORITY_UNAVAILABLE',
      retryable: true,
    },
    undefined,
    { 'Retry-After': '3' },
  );
}
