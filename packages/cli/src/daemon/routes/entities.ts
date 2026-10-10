import { authenticatedAgentAddress, canAdministerNode } from '../../auth.js';
import { EntityGraphReader } from '../../entity-search/documents.js';
import { EntitySearchError } from '../../entity-search/types.js';
import { jsonResponse, readBody, safeParseJson, SMALL_BODY_BYTES, validateRequiredContextGraphId,
  respondIfStoreUnavailable, respondIfContextGraphReadAuthorityUnavailable } from '../http-utils.js';
import { createStoreQueryRequestLifecycle, isApiQueryCallerDisconnected } from '../store-query-lifecycle.js';
import type { RequestContext } from './context.js';

export async function handleEntityRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path, authentication, agent, entitySearch } = ctx;
  if (!['/api/entities/index', '/api/entities/search'].includes(path)) return;
  if (req.method !== 'POST') { jsonResponse(res, 405, { code: 'METHOD_NOT_ALLOWED' }); return; }
  const indexing = path.endsWith('/index');
  if (indexing && !canAdministerNode(authentication)) {
    jsonResponse(res, 403, { code: 'NODE_OPERATOR_REQUIRED' }); return;
  }
  if (!entitySearch) { jsonResponse(res, 503, { code: 'ENTITY_SEARCH_DISABLED' }); return; }
  const body = safeParseJson(await readBody(req, SMALL_BODY_BYTES), res);
  if (!body || !validateRequiredContextGraphId(body.contextGraphId, res)) return;
  const timeoutMs = body.timeoutMs ?? (indexing ? 30_000 : 2_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > (indexing ? 30_000 : 5_000)
    || (body.restart !== undefined && typeof body.restart !== 'boolean')) {
    jsonResponse(res, 400, { code: 'ENTITY_INVALID_REQUEST' }); return;
  }
  const lifecycle = createStoreQueryRequestLifecycle(req, res, 'api.entities');
  const deadline = performance.now() + timeoutMs;
  const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(timeoutMs)]);
  const reader = new EntityGraphReader(agent, authenticatedAgentAddress(authentication), indexing ? 'background' : 'normal');
  try {
    const reply = indexing
      ? await entitySearch.index(body, reader, body.restart === true, signal, deadline)
      : await entitySearch.search(body.indexId, body.contextGraphId, body.query, body.limit ?? 5, reader, signal, deadline);
    jsonResponse(res, 200, { version: 1, ...reply });
  } catch (error) {
    if (lifecycle.signal.aborted || isApiQueryCallerDisconnected(error)) return;
    if (signal.aborted || performance.now() >= deadline) { jsonResponse(res, 503, { code: 'QUERY_DEADLINE_EXCEEDED' }); return; }
    if (error instanceof EntitySearchError) { jsonResponse(res, error.status, { code: error.code }); return; }
    if ((error as { code?: string })?.code === 'QUERY_ACCESS_DENIED') { jsonResponse(res, 403, { code: 'QUERY_ACCESS_DENIED' }); return; }
    if (respondIfStoreUnavailable(res, error) !== null || respondIfContextGraphReadAuthorityUnavailable(res, error)) return;
    jsonResponse(res, 503, { code: 'ENTITY_SEARCH_UNAVAILABLE' });
  } finally { lifecycle.dispose(); }
}
