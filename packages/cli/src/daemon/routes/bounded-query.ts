import { randomUUID } from 'node:crypto';
import { authenticatedAgentAddress } from '../../auth.js';
import {
  jsonResponse, readBody, safeParseJson, SMALL_BODY_BYTES,
  validateRequiredContextGraphId, respondIfStoreUnavailable,
  respondIfContextGraphReadAuthorityUnavailable,
} from '../http-utils.js';
import { createStoreQueryRequestLifecycle, isApiQueryCallerDisconnected } from '../store-query-lifecycle.js';
import {
  boundSelect, boundedResult, BOUNDED_QUERY_VERSION, BOUNDED_QUERY_MAX_ROWS,
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
      paging: 'offset',
    });
    return;
  }
  if (req.method !== 'POST') return;
  const parsed = safeParseJson(await readBody(req, SMALL_BODY_BYTES), res);
  if (!parsed) return;
  if (!validateRequiredContextGraphId(parsed.contextGraphId, res)) return;
  const timeoutMs = parsed.timeoutMs ?? BOUNDED_QUERY_MAX_TIMEOUT_MS;
  const mode = parsed.mode ?? 'complete';
  const offset = parsed.offset ?? 0;
  if (parsed.version !== BOUNDED_QUERY_VERSION || !Number.isInteger(timeoutMs)
      || timeoutMs < 1 || timeoutMs > BOUNDED_QUERY_MAX_TIMEOUT_MS
      || !['complete', 'page'].includes(mode) || !Number.isSafeInteger(offset)
      || offset < 0 || offset > 1_000_000 || (mode === 'complete' && offset !== 0)
      || ![undefined, 'verifiable-memory', 'shared-working-memory'].includes(parsed.view)) {
    jsonResponse(res, 400, { code: 'BOUNDED_QUERY_INVALID_REQUEST', error: 'Unsupported version, view or deadline' });
    return;
  }
  let query: ReturnType<typeof boundSelect>;
  try { query = boundSelect(parsed.sparql, parsed.maxRows); }
  catch (error) {
    jsonResponse(res, 400, { code: 'BOUNDED_QUERY_INVALID_REQUEST', error: (error as Error).message });
    return;
  }
  const lifecycle = createStoreQueryRequestLifecycle(req, res, 'api.query.bounded');
  const deadlineAt = performance.now() + timeoutMs;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([lifecycle.signal, deadline]);
  const callerAgentAddress = authenticatedAgentAddress(authentication);
  try {
    const options = {
      contextGraphId: parsed.contextGraphId, callerAgentAddress, view: parsed.view,
      includeContextGraphPartitions: parsed.includeContextGraphPartitions === true,
      signal, priority: lifecycle.priority, source: lifecycle.source,
      accessDenied: 'error' as const, redactQuery: true, maxResponseBytes: BOUNDED_QUERY_MAX_BYTES,
    };
    const result = await agent.query(query.sparql + (offset ? ` OFFSET ${offset}` : ''), options);
    signal.throwIfAborted();
    if (performance.now() >= deadlineAt) throw new DOMException("Query deadline exceeded", "TimeoutError");
    const hasMore = result.bindings.length > query.maxRows;
    const rows = mode === 'page' ? result.bindings.slice(0, query.maxRows) : result.bindings;
    const bounded = boundedResult(rows, query.maxRows);
    if (!bounded.ok) {
      jsonResponse(res, 422, { code: bounded.code, error: 'Query result exceeds the requested bound; narrow the selection' });
      return;
    }
    jsonResponse(res, 200, {
      version: BOUNDED_QUERY_VERSION, queryId: randomUUID(), observedAt: new Date().toISOString(),
      contextGraphId: parsed.contextGraphId, coverage: 'local-only', mode,
      resultComplete: mode === 'complete',
      ...(mode === 'page' ? { pageComplete: true, hasMore, offset, nextOffset: offset + rows.length } : {}),
      result: bounded.result,
    });
  } catch (error) {
    if (isApiQueryCallerDisconnected(error) || lifecycle.signal.aborted) return;
    if (deadline.aborted || performance.now() >= deadlineAt) {
      jsonResponse(res, 503, { code: 'QUERY_DEADLINE_EXCEEDED', error: 'Local query deadline exceeded', retryable: true });
      return;
    }
    if ((error as { code?: string })?.code === 'STORE_RESPONSE_TOO_LARGE') {
      jsonResponse(res, 422, { code: 'QUERY_RESULT_TOO_LARGE', error: 'Store response exceeds the byte bound' });
      return;
    }
    if ((error as { code?: string })?.code === 'QUERY_ACCESS_DENIED') {
      jsonResponse(res, 403, { code: 'QUERY_ACCESS_DENIED', error: 'Context Graph read denied' });
      return;
    }
    if (respondIfStoreUnavailable(res, error) !== null) return;
    if (respondIfContextGraphReadAuthorityUnavailable(res, error)) return;
    if (respondToQueryFailure(res, error)) return;
    jsonResponse(res, 503, { code: 'QUERY_UNAVAILABLE', error: 'Local query unavailable', retryable: true });
  } finally { lifecycle.dispose(); }
}
