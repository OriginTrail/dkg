import { isQueryResultTooLargeError } from '@origintrail-official/dkg-agent';
import { startRequestAbortLifecycle, resolveWithinAbort, isQueryAccessDeniedError, QUERY_ACCESS_DENIED_CODE, QUERY_ACCESS_DENIED_MESSAGE } from '@origintrail-official/dkg-core';
import { randomUUID } from 'node:crypto';
import { authenticatedAgentAddress } from '../../auth.js';
import {
  jsonResponse, readBody, safeParseJson, SMALL_BODY_BYTES,
  validateRequiredContextGraphId, respondIfStoreUnavailable,
  respondIfContextGraphReadAuthorityUnavailable, sendSerializedJsonResponse,
} from '../http-utils.js';
import { createStoreQueryRequestLifecycle, isApiQueryCallerDisconnected } from '../store-query-lifecycle.js';
import {
  boundedQueryPolicy, finalizeBoundedQuery, BOUNDED_QUERY_VERSION, BOUNDED_QUERY_MAX_ROWS,
  BOUNDED_QUERY_MAX_BYTES, BOUNDED_QUERY_MAX_TIMEOUT_MS,
} from '../bounded-query.js';
import { respondToQueryFailure } from './query-error.js';
import type { RequestContext } from './context.js';

/** Bounded local reads for latency-sensitive consumers, using the normal CG authorization and store lane. */
export async function handleBoundedQueryRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path, agent, authentication } = ctx;
  if (path !== '/api/query/bounded') return;
  if (req.method === 'GET') {
    jsonResponse(res, 200, {
      version: BOUNDED_QUERY_VERSION, maxRows: BOUNDED_QUERY_MAX_ROWS,
      maxResultBytes: BOUNDED_QUERY_MAX_BYTES, maxTimeoutMs: BOUNDED_QUERY_MAX_TIMEOUT_MS,
      coverage: 'local-only', truncation: 'error',
      paging: 'offset', chainEvidenceModes: ['rpc-only', 'core-cache'],
    });
    return;
  }
  if (req.method !== 'POST') return;
  const parsed = safeParseJson(await readBody(req, SMALL_BODY_BYTES), res);
  if (!parsed) return;
  if (!validateRequiredContextGraphId(parsed.contextGraphId, res)) return;
  let query: ReturnType<typeof boundedQueryPolicy>;
  try { query = boundedQueryPolicy(parsed); }
  catch (error) {
    jsonResponse(res, 400, { code: 'BOUNDED_QUERY_INVALID_REQUEST', error: (error as Error).message });
    return;
  }
  const lifecycle = createStoreQueryRequestLifecycle(req, res, 'api.query.bounded');
  const deadlineAt = performance.now() + query.timeoutMs;
  const abortLifecycle = startRequestAbortLifecycle(query.timeoutMs, [lifecycle.signal]);
  const { signal, deadline } = abortLifecycle;
  const callerAgentAddress = authenticatedAgentAddress(authentication);
  try {
    const options = {
      contextGraphId: parsed.contextGraphId, callerAgentAddress, view: query.view,
      includeContextGraphPartitions: query.includeContextGraphPartitions, chainEvidenceMode: query.chainEvidenceMode,
      excludeWorkingMemoryPartitions: true, requireCompleteGraphScope: true,
      signal, priority: lifecycle.priority, source: lifecycle.source,
      accessDenied: 'error' as const, redactQuery: true, maxResponseBytes: BOUNDED_QUERY_MAX_BYTES,
    };
    const result = await resolveWithinAbort(() => agent.query(query.sparql, options), signal);
    signal.throwIfAborted();
    if (performance.now() >= deadlineAt) throw new DOMException("Query deadline exceeded", "TimeoutError");
    if (result === null) throw signal.reason;
    const bounded = finalizeBoundedQuery(query, result.bindings);
    if (!bounded.ok) {
      jsonResponse(res, 422, { code: bounded.code, error: 'Query result exceeds the requested bound; narrow the selection' });
      return;
    }
    // Validating and serializing the result is synchronous, so the deadline
    // timer cannot interrupt it: the deadline is judged once the answer is ready.
    // Bindings are caller data: error-shaped variable names must stay byte-exact.
    const body = JSON.stringify({
      version: BOUNDED_QUERY_VERSION, queryId: randomUUID(), observedAt: new Date().toISOString(),
      contextGraphId: parsed.contextGraphId, coverage: 'local-only', chainEvidenceMode: query.chainEvidenceMode ?? 'rpc-only', ...bounded.response,
    });
    if (performance.now() >= deadlineAt) throw new DOMException("Query deadline exceeded", "TimeoutError");
    sendSerializedJsonResponse(res, 200, body);
  } catch (error) {
    if (isApiQueryCallerDisconnected(error) || lifecycle.signal.aborted) return;
    if (deadline.aborted || performance.now() >= deadlineAt) {
      jsonResponse(res, 503, { code: 'QUERY_DEADLINE_EXCEEDED', error: 'Local query deadline exceeded', retryable: true });
      return;
    }
    if (isQueryResultTooLargeError(error) || (error as { code?: string })?.code === 'STORE_RESPONSE_TOO_LARGE') {
      jsonResponse(res, 422, { code: 'QUERY_RESULT_TOO_LARGE', error: 'Store response exceeds the byte bound' });
      return;
    }
    if (isQueryAccessDeniedError(error)) {
      jsonResponse(res, 403, { code: QUERY_ACCESS_DENIED_CODE, error: QUERY_ACCESS_DENIED_MESSAGE });
      return;
    }
    if (respondIfStoreUnavailable(res, error) !== null) return;
    if (respondIfContextGraphReadAuthorityUnavailable(res, error)) return;
    if (respondToQueryFailure(res, error)) return;
    jsonResponse(res, 503, { code: 'QUERY_UNAVAILABLE', error: 'Local query unavailable', retryable: true });
  } finally { abortLifecycle.release(); lifecycle.dispose(); }
}
