import { authenticatedAgentAddress, canAdministerNode } from '../../auth.js';
import { EntityGraphReader } from '../../entity-search/documents.js';
import { parseEntityOperation } from '../../entity-search/requests.js';
import type { EntityOperation } from '../../entity-search/types.js';
import { EntitySearchError, checkDeadline } from '../../entity-search/types.js';
import { jsonResponse, readBody, safeParseJson, SMALL_BODY_BYTES, validateRequiredContextGraphId,
  respondIfStoreUnavailable, respondIfContextGraphReadAuthorityUnavailable } from '../http-utils.js';
import { createStoreQueryRequestLifecycle, isApiQueryCallerDisconnected } from '../store-query-lifecycle.js';
import { respondToQueryFailure } from './query-error.js';
import type { RequestContext } from './context.js';

export async function handleEntityRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, path, authentication, agent, entitySearch } = ctx;
  if (!['/api/entities/index', '/api/entities/search', '/api/entities/readiness'].includes(path)) return;
  if (req.method !== 'POST') { jsonResponse(res, 405, { code: 'METHOD_NOT_ALLOWED' }); return; }
  const kind = path.endsWith('/index') ? 'index' : path.endsWith('/readiness') ? 'readiness' : 'search';
  if (kind === 'index' && !canAdministerNode(authentication)) {
    jsonResponse(res, 403, { code: 'NODE_OPERATOR_REQUIRED' }); return;
  }
  if (!entitySearch) { jsonResponse(res, 503, { code: 'ENTITY_SEARCH_DISABLED' }); return; }
  const body: Record<string, unknown> | null = safeParseJson(await readBody(req, SMALL_BODY_BYTES), res);
  if (!body || !validateRequiredContextGraphId(body.contextGraphId, res)) return;
  let operation: EntityOperation;
  try { operation = parseEntityOperation(kind, body); }
  catch (error) {
    if (error instanceof EntitySearchError) { jsonResponse(res, error.status, { code: error.code }); return; }
    throw error;
  }
  const { timeoutMs } = operation.request;
  const lifecycle = createStoreQueryRequestLifecycle(req, res, 'api.entities');
  const deadline = performance.now() + timeoutMs;
  const signal = AbortSignal.any([lifecycle.signal, AbortSignal.timeout(timeoutMs)]);
  const reader = new EntityGraphReader(agent, authenticatedAgentAddress(authentication), operation.kind === 'index' ? 'background' : lifecycle.priority);
  try {
    let reply;
    switch (operation.kind) {
      case 'index': reply = await entitySearch.index(operation.request, reader, signal, deadline); break;
      case 'readiness': reply = await entitySearch.readiness(operation.request, reader, signal, deadline); break;
      case 'search': reply = await entitySearch.search(operation.request, reader, signal, deadline); break;
    }
    checkDeadline(signal, deadline);
    jsonResponse(res, 200, { version: 1, ...reply, chainEvidenceMode: operation.request.chainEvidenceMode });
  } catch (error) {
    if (lifecycle.signal.aborted || isApiQueryCallerDisconnected(error)) return;
    if (signal.aborted || performance.now() >= deadline) { jsonResponse(res, 503, { code: 'QUERY_DEADLINE_EXCEEDED' }); return; }
    if (error instanceof EntitySearchError) { jsonResponse(res, error.status, { code: error.code }); return; }
    if ((error as { code?: string })?.code === 'QUERY_ACCESS_DENIED') { jsonResponse(res, 403, { code: 'QUERY_ACCESS_DENIED' }); return; }
    if (respondToQueryFailure(res, error)) return;
    if (respondIfStoreUnavailable(res, error) !== null || respondIfContextGraphReadAuthorityUnavailable(res, error)) return;
    jsonResponse(res, 503, { code: 'ENTITY_SEARCH_UNAVAILABLE' });
  } finally { lifecycle.dispose(); }
}
