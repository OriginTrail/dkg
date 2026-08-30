import type { RequestContext } from './context.js';
import {
  assertSafeIri,
  assertSafeRdfTerm,
  getMetrics,
} from '@origintrail-official/dkg-core';
import {
  decodeQueryCatalogBindings,
  QUERY_CATALOG_READ_CAPABILITIES,
  QUERY_CATALOG_SCHEMA_VERSION,
} from '@origintrail-official/dkg-core/query-catalog';
import {
  jsonResponse,
  readBody,
  resolveRequiredWriteContextGraphId,
  respondIfStoreUnavailable,
  safeParseJson,
  SMALL_BODY_BYTES,
  validateRequiredContextGraphId,
  validateWritableQuadLiteralSizes,
} from '../http-utils.js';
import {
  createStoreQueryRequestLifecycle,
  isApiQueryCallerDisconnected,
} from '../store-query-lifecycle.js';
import {
  contextGraphQueryCatalogMetaUri,
  QueryCatalogValidationError,
  QueryCatalogWriteConflictError,
  readContextGraphQueryCatalogBindings,
  writeContextGraphQueryCatalog,
} from '../query-catalog-service.js';

const QUERY_CATALOG_RESULT_LIMIT = 5_000;
const QUERY_CATALOG_RESPONSE_BYTES = 1024 * 1024;

/**
 * Semantic query-catalog HTTP boundary. Persistence belongs to the Context
 * Graph `meta` subgraph; this module deliberately exposes no generic storage
 * mutation API.
 */
export async function handleQueryCatalogRoutes(ctx: RequestContext): Promise<boolean> {
  const {
    req,
    res,
    agent,
    path,
    requestPrincipal,
    emitMemoryGraphChanged,
  } = ctx;

  if (req.method === 'POST' && path === '/api/profile/query-catalog/write') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return true;
    if (parsed.mode !== undefined) {
      jsonResponse(res, 400, {
        error: 'Query catalog writes are immutable; "mode" is not supported.',
        code: 'QUERY_CATALOG_MUTATION_MODE_UNSUPPORTED',
      });
      return true;
    }

    const callerAgentAddress = requestPrincipal.kind === 'agent'
      ? requestPrincipal.agentAddress
      : undefined;
    const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(
      agent,
      parsed.contextGraphId,
      res,
      {
        callerAgentAddress,
        allowLocalExactFallback: !callerAgentAddress,
      },
    );
    if (!resolvedContextGraphId) return true;

    if (!Array.isArray(parsed.quads) || parsed.quads.length === 0) {
      jsonResponse(res, 400, {
        error: 'Missing or invalid "quads" (must be a non-empty array)',
      });
      return true;
    }
    try {
      const normalized = parsed.quads.map((quad: unknown, index: number) => {
        if (!quad || typeof quad !== 'object' || Array.isArray(quad)) {
          throw new QueryCatalogValidationError(`quads[${index}] must be an object`);
        }
        const value = quad as Record<string, unknown>;
        if (typeof value.subject !== 'string' || value.subject.length === 0) {
          throw new QueryCatalogValidationError(`quads[${index}].subject must be a non-empty string`);
        }
        if (typeof value.predicate !== 'string' || value.predicate.length === 0) {
          throw new QueryCatalogValidationError(`quads[${index}].predicate must be a non-empty string`);
        }
        if (typeof value.object !== 'string' || value.object.length === 0) {
          throw new QueryCatalogValidationError(`quads[${index}].object must be a non-empty string`);
        }
        assertSafeIri(value.subject);
        assertSafeIri(value.predicate);
        if (value.object.startsWith('"')) assertSafeRdfTerm(value.object);
        else assertSafeIri(value.object);
        return {
          subject: value.subject,
          predicate: value.predicate,
          object: value.object,
          graph: '',
        };
      });
      const literalSize = validateWritableQuadLiteralSizes('quads', normalized);
      if (!literalSize.ok) {
        jsonResponse(res, 400, literalSize.body);
        return true;
      }

      const result = await writeContextGraphQueryCatalog(
        agent,
        resolvedContextGraphId,
        normalized,
        { callerAgentAddress },
      );
      if (result.triplesWritten > 0) {
        emitMemoryGraphChanged?.({
          contextGraphId: resolvedContextGraphId,
          layers: ['wm'],
          subGraphName: 'meta',
          operation: 'query_catalog_written',
          source: 'api',
          counts: { triples: result.triplesWritten },
        });
      }
      jsonResponse(res, 200, { ok: true, ...result });
      return true;
    } catch (err: any) {
      if (err instanceof QueryCatalogValidationError) {
        jsonResponse(res, 400, { error: err.message, code: err.code });
        return true;
      }
      if (err instanceof QueryCatalogWriteConflictError) {
        jsonResponse(res, 409, { error: err.message, code: err.code });
        return true;
      }
      if (respondIfStoreUnavailable(res, err) !== null) return true;
      jsonResponse(res, 500, {
        error: err?.message ?? 'Query catalog write failed',
        code: 'QUERY_CATALOG_WRITE_FAILED',
      });
      return true;
    }
  }

  if (req.method === 'POST' && path === '/api/profile/query-catalog/read') {
    const body = await readBody(req, SMALL_BODY_BYTES);
    const parsed = safeParseJson(body, res);
    if (!parsed) return true;
    const contextGraphId = parsed.contextGraphId;
    if (!validateRequiredContextGraphId(contextGraphId, res)) return true;

    const callerAgentAddress = requestPrincipal.kind === 'agent'
      ? requestPrincipal.agentAddress
      : undefined;
    const isNodeAdmin = requestPrincipal.kind === 'nodeOperator';
    if (
      !isNodeAdmin
      && !(await agent.canReadContextGraph(contextGraphId, { callerAgentAddress }))
    ) {
      jsonResponse(res, 403, {
        error: `Not authorized to read query catalog for context graph "${contextGraphId}".`,
      });
      return true;
    }

    const lifecycle = createStoreQueryRequestLifecycle(
      req,
      res,
      'api.profile.query_catalog.read',
    );
    let rawBindings: Array<Record<string, unknown>>;
    try {
      rawBindings = await readContextGraphQueryCatalogBindings(agent, contextGraphId, {
        signal: lifecycle.signal,
        priority: lifecycle.priority,
        source: lifecycle.source,
        callerAgentAddress,
      });
    } catch (err: any) {
      if (isApiQueryCallerDisconnected(err) || lifecycle.signal.aborted) {
        if (!res.writableEnded) res.end();
        return true;
      }
      if (respondIfStoreUnavailable(res, err) !== null) return true;
      if (err?.code === 'STORE_RESPONSE_TOO_LARGE') {
        jsonResponse(res, 413, {
          error: err?.message ?? 'Query catalog response exceeded the byte limit',
          code: 'QUERY_CATALOG_RESULT_TOO_LARGE',
          limitBytes: QUERY_CATALOG_RESPONSE_BYTES,
          ...(typeof err?.actualBytes === 'number' ? { actualBytes: err.actualBytes } : {}),
        });
        return true;
      }
      jsonResponse(res, 500, {
        error: err?.message ?? 'Query catalog read failed',
        code: 'QUERY_CATALOG_READ_FAILED',
      });
      return true;
    } finally {
      lifecycle.dispose();
    }

    if (rawBindings.length > QUERY_CATALOG_RESULT_LIMIT) {
      jsonResponse(res, 413, {
        error: `Query catalog result exceeds the ${QUERY_CATALOG_RESULT_LIMIT}-row limit.`,
        code: 'QUERY_CATALOG_RESULT_TOO_LARGE',
        limitRows: QUERY_CATALOG_RESULT_LIMIT,
      });
      return true;
    }
    let items;
    try {
      items = decodeQueryCatalogBindings(rawBindings, {
        contextGraphId,
      });
    } catch (err: any) {
      jsonResponse(res, 422, {
        error: err?.message ?? 'Stored query catalog data is invalid',
        code: 'QUERY_CATALOG_INVALID_DATA',
      });
      return true;
    }
    const payload = {
      schemaVersion: QUERY_CATALOG_SCHEMA_VERSION,
      capabilities: QUERY_CATALOG_READ_CAPABILITIES,
      contextGraphId,
      graph: contextGraphQueryCatalogMetaUri(contextGraphId),
      items,
      result: {
        type: 'bindings' as const,
        bindings: rawBindings,
      },
    };
    const responseBytes = Buffer.byteLength(JSON.stringify(payload));
    getMetrics().storeQueryResultRows.record(rawBindings.length, { source: lifecycle.source });
    getMetrics().storeQueryResultBytesEstimate.record(responseBytes, { source: lifecycle.source });
    if (responseBytes > QUERY_CATALOG_RESPONSE_BYTES) {
      jsonResponse(res, 413, {
        error: 'Query catalog response exceeds the 1 MiB serialized-response limit.',
        code: 'QUERY_CATALOG_RESULT_TOO_LARGE',
        limitBytes: QUERY_CATALOG_RESPONSE_BYTES,
        actualBytes: responseBytes,
      });
      return true;
    }
    jsonResponse(res, 200, payload);
    return true;
  }

  return false;
}
