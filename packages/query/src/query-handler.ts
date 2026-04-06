import type { PeerId } from '@origintrail-official/dkg-core';
import { contextGraphDataUri, assertSafeIri, escapeSparqlLiteral } from '@origintrail-official/dkg-core';
import { stripLiteralsAndComments } from './sparql-utils.js';
import { validateReadOnlySparql } from './sparql-guard.js';
import type { DKGQueryEngine } from './dkg-query-engine.js';
import type {
  QueryRequest,
  QueryResponse,
  QueryAccessConfig,
  ContextGraphQueryPolicy,
  LookupType,
  QueryStatus,
} from './query-types.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const MAX_RESULT_BYTES = 1_048_576; // 1 MB

interface RateBucket {
  count: number;
  resetAt: number;
}

/**
 * Handles incoming cross-agent query requests over the
 * /dkg/query/2.0.0 libp2p protocol.
 *
 * Evaluates access policy, rate limits, dispatches to the local query
 * engine, and enforces result size limits.
 */
export class QueryHandler {
  private readonly queryEngine: DKGQueryEngine;
  private readonly config: QueryAccessConfig;
  private readonly rateBuckets = new Map<string, RateBucket>();
  private readonly defaultRatePerMinute: number;

  constructor(queryEngine: DKGQueryEngine, config: QueryAccessConfig) {
    this.queryEngine = queryEngine;
    this.config = config;
    this.defaultRatePerMinute = config.rateLimitPerMinute ?? 60;
  }

  /**
   * StreamHandler-compatible entry point.
   * Decodes the request JSON, processes it, returns response JSON.
   */
  get handler(): (data: Uint8Array, peerId: PeerId) => Promise<Uint8Array> {
    return async (data: Uint8Array, peerId: PeerId): Promise<Uint8Array> => {
      let request: QueryRequest;
      try {
        const text = new TextDecoder().decode(data);
        request = JSON.parse(text) as QueryRequest;
      } catch {
        return encode(errorResponse('', 'ERROR', 'Invalid request: malformed JSON'));
      }

      const response = await this.handle(request, peerId.toString());
      return encode(response);
    };
  }

  async handle(request: QueryRequest, peerId: string): Promise<QueryResponse> {
    const opId = request.operationId ?? '';

    // Validate request structure
    if (request.lookupType === undefined || request.lookupType === null) {
      return errorResponse(opId, 'ERROR', 'Invalid request: missing lookupType');
    }

    // Resolve context graph (ENTITY_BY_UAL doesn't need it upfront)
    const contextGraphId = request.contextGraphId ?? request.paranetId;
    if (request.lookupType !== 'ENTITY_BY_UAL' && !contextGraphId) {
      return errorResponse(opId, 'ERROR', 'Invalid request: contextGraphId is required for this lookup type');
    }

    // Access policy check
    const accessResult = this.checkAccess(request.lookupType, contextGraphId, peerId);
    if (accessResult) return { ...accessResult, operationId: opId };

    // Rate limit check
    const rateResult = this.checkRateLimit(peerId);
    if (rateResult) return { ...rateResult, operationId: opId };

    // Dispatch to lookup handler
    try {
      const limit = Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const timeout = Math.min(request.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

      let response: QueryResponse;

      switch (request.lookupType) {
        case 'ENTITY_BY_UAL':
          response = await this.lookupByUAL(opId, request.ual!);
          break;
        case 'ENTITIES_BY_TYPE':
          response = await this.lookupByType(opId, contextGraphId!, request.rdfType!, limit);
          break;
        case 'ENTITY_TRIPLES':
          response = await this.lookupEntityTriples(opId, contextGraphId!, request.entityUri!);
          break;
        case 'SPARQL_QUERY':
          response = await this.executeSparql(opId, contextGraphId!, request.sparql!, limit, timeout);
          break;
        default:
          response = errorResponse(opId, 'UNSUPPORTED_LOOKUP', `Unknown lookup type: ${request.lookupType}`);
      }

      return this.enforceResultSize(response);
    } catch (err) {
      return errorResponse(opId, 'ERROR', 'Internal error processing query');
    }
  }

  private checkAccess(
    lookupType: LookupType,
    contextGraphId: string | undefined,
    peerId: string,
  ): QueryResponse | null {
    const defaultPolicy = this.config.defaultPolicy ?? 'deny';

    // For ENTITY_BY_UAL, we skip context-graph-level check (UAL resolves internally)
    if (lookupType === 'ENTITY_BY_UAL') {
      if (defaultPolicy === 'deny' && !this.hasAnyPublicContextGraph()) {
        return errorResponse('', 'ACCESS_DENIED', 'No context graphs are queryable on this node');
      }
      return null;
    }

    const cgConfigs = this.config.contextGraphs ?? this.config.paranets;
    const cgConfig = cgConfigs?.[contextGraphId!];
    if (!cgConfig) {
      if (defaultPolicy === 'deny') {
        return errorResponse('', 'ACCESS_DENIED', `Context graph '${contextGraphId}' is not queryable`);
      }
      // defaultPolicy is 'public' — allow with default lookup types
      return null;
    }

    // Check peer access
    if (cgConfig.policy === 'deny') {
      return errorResponse('', 'ACCESS_DENIED', `Context graph '${contextGraphId}' is not queryable`);
    }
    if (cgConfig.policy === 'allowList') {
      if (!cgConfig.allowedPeers?.includes(peerId)) {
        return errorResponse('', 'ACCESS_DENIED', 'Your peer ID is not in the allow list');
      }
    }

    // Check lookup type
    if (cgConfig.allowedLookupTypes?.length) {
      if (!cgConfig.allowedLookupTypes.includes(lookupType)) {
        return errorResponse('', 'UNSUPPORTED_LOOKUP', `Lookup type '${lookupType}' is not allowed for context graph '${contextGraphId}'`);
      }
    }

    // Check SPARQL specifically
    if (lookupType === 'SPARQL_QUERY' && !cgConfig.sparqlEnabled) {
      return errorResponse('', 'UNSUPPORTED_LOOKUP', `SPARQL queries are not enabled for context graph '${contextGraphId}'`);
    }

    return null;
  }

  private hasAnyPublicContextGraph(): boolean {
    if (this.config.defaultPolicy === 'public') return true;
    const cgConfigs = this.config.contextGraphs ?? this.config.paranets;
    if (!cgConfigs) return false;
    return Object.values(cgConfigs).some(p => p.policy === 'public');
  }

  private checkRateLimit(peerId: string): QueryResponse | null {
    const now = Date.now();
    let bucket = this.rateBuckets.get(peerId);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60_000 };
      this.rateBuckets.set(peerId, bucket);
    }

    bucket.count++;
    if (bucket.count > this.defaultRatePerMinute) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      return errorResponse(
        '',
        'RATE_LIMITED',
        `Rate limit exceeded. Retry after ${retryAfter} seconds`,
      );
    }

    return null;
  }

  private async lookupByUAL(opId: string, ual: string): Promise<QueryResponse> {
    if (!ual) {
      return errorResponse(opId, 'ERROR', 'Invalid request: missing ual');
    }

    try {
      const resolved = await this.queryEngine.resolveKA(ual);
      const ntriples = resolved.quads
        .map(q => `<${q.subject}> <${q.predicate}> ${formatObject(q.object)} .`)
        .join('\n');

      return {
        operationId: opId,
        status: 'OK',
        ntriples,
        truncated: false,
        resultCount: resolved.quads.length,
      };
    } catch {
      return errorResponse(opId, 'ERROR', `Failed to resolve UAL: ${ual}`);
    }
  }

  private async lookupByType(
    opId: string,
    contextGraphId: string,
    rdfType: string,
    limit: number,
  ): Promise<QueryResponse> {
    if (!rdfType) {
      return errorResponse(opId, 'ERROR', 'Invalid request: missing rdfType');
    }

    const dataGraph = contextGraphDataUri(contextGraphId);
    const sparql = `SELECT DISTINCT ?entity WHERE { GRAPH <${assertSafeIri(dataGraph)}> { ?entity a <${assertSafeIri(rdfType)}> } } LIMIT ${limit}`;

    const result = await this.queryEngine.query(sparql);
    const entityUris = result.bindings.map(b => b['entity']);

    return {
      operationId: opId,
      status: 'OK',
      entityUris,
      truncated: entityUris.length >= limit,
      resultCount: entityUris.length,
    };
  }

  private async lookupEntityTriples(
    opId: string,
    contextGraphId: string,
    entityUri: string,
  ): Promise<QueryResponse> {
    if (!entityUri) {
      return errorResponse(opId, 'ERROR', 'Invalid request: missing entityUri');
    }

    const dataGraph = contextGraphDataUri(contextGraphId);
    const sparql = `SELECT ?p ?o WHERE { GRAPH <${assertSafeIri(dataGraph)}> { <${assertSafeIri(entityUri)}> ?p ?o } }`;
    const result = await this.queryEngine.query(sparql);

    const ntriples = result.bindings
      .map(b => `<${entityUri}> <${b['p']}> ${formatObject(b['o'])} .`)
      .join('\n');

    return {
      operationId: opId,
      status: 'OK',
      ntriples,
      truncated: false,
      resultCount: result.bindings.length,
    };
  }

  private async executeSparql(
    opId: string,
    contextGraphId: string,
    sparql: string,
    limit: number,
    timeout: number,
  ): Promise<QueryResponse> {
    if (!sparql) {
      return errorResponse(opId, 'ERROR', 'Invalid request: missing sparql');
    }

    // Strip string literals and comments so regexes don't false-positive
    // on keywords inside quoted values or variable names like ?graph.
    const stripped = stripLiteralsAndComments(sparql);

    if (/\bSERVICE\b/i.test(stripped)) {
      return errorResponse(opId, 'ERROR', 'SERVICE clauses are not allowed in remote queries');
    }

    if (/\bGRAPH\s+/i.test(stripped)) {
      return errorResponse(opId, 'ERROR', 'Explicit GRAPH clauses are not allowed in remote queries — queries are automatically scoped to the target context graph');
    }

    if (/\bFROM\s+/i.test(stripped)) {
      return errorResponse(opId, 'ERROR', 'FROM/FROM NAMED clauses are not allowed in remote queries — queries are automatically scoped to the target context graph');
    }

    const guard = validateReadOnlySparql(sparql);
    if (!guard.safe) {
      return errorResponse(opId, 'ERROR', `SPARQL rejected: ${guard.reason}`);
    }

    // Execute with timeout
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      this.queryEngine.query(sparql, { contextGraphId }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeout);
      }),
    ]).catch(err => {
      if (err.message === 'timeout') {
        return { _timeout: true } as any;
      }
      throw err;
    }).finally(() => clearTimeout(timer!));

    if (result._timeout) {
      return errorResponse(opId, 'GAS_LIMIT_EXCEEDED', `Query exceeded time limit (${timeout}ms)`);
    }

    const bindings = result.bindings.slice(0, limit);
    return {
      operationId: opId,
      status: 'OK',
      bindings: JSON.stringify(bindings),
      truncated: result.bindings.length > limit,
      resultCount: result.bindings.length,
    };
  }

  private enforceResultSize(response: QueryResponse): QueryResponse {
    const serialized = JSON.stringify(response);
    if (serialized.length <= MAX_RESULT_BYTES) return response;

    return {
      ...response,
      truncated: true,
      ntriples: response.ntriples?.slice(0, MAX_RESULT_BYTES) ?? response.ntriples,
      bindings: response.bindings?.slice(0, MAX_RESULT_BYTES) ?? response.bindings,
    };
  }
}

function errorResponse(opId: string, status: QueryStatus, error: string): QueryResponse {
  return {
    operationId: opId,
    status,
    truncated: false,
    resultCount: 0,
    error,
  };
}

function formatObject(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) return value;
  return `<${value}>`;
}

function encode(response: QueryResponse): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(response));
}

