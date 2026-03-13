import type { PeerId } from '@dkg/core';
import { paranetDataGraphUri, assertSafeIri, escapeSparqlLiteral } from '@dkg/core';
import { stripLiteralsAndComments } from './sparql-utils.js';
import { validateReadOnlySparql } from './sparql-guard.js';
import type { DKGQueryEngine } from './dkg-query-engine.js';
import type {
  QueryRequest,
  QueryResponse,
  QueryAccessConfig,
  ParanetQueryPolicy,
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

    // Resolve paranet (ENTITY_BY_UAL doesn't need it upfront)
    const paranetId = request.paranetId;
    if (request.lookupType !== 'ENTITY_BY_UAL' && !paranetId) {
      return errorResponse(opId, 'ERROR', 'Invalid request: paranetId is required for this lookup type');
    }

    // Access policy check
    const accessResult = this.checkAccess(request.lookupType, paranetId, peerId);
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
          response = await this.lookupByType(opId, paranetId!, request.rdfType!, limit);
          break;
        case 'ENTITY_TRIPLES':
          response = await this.lookupEntityTriples(opId, paranetId!, request.entityUri!);
          break;
        case 'SPARQL_QUERY':
          response = await this.executeSparql(opId, paranetId!, request.sparql!, limit, timeout);
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
    paranetId: string | undefined,
    peerId: string,
  ): QueryResponse | null {
    const defaultPolicy = this.config.defaultPolicy ?? 'deny';

    // For ENTITY_BY_UAL, we skip paranet-level check (UAL resolves internally)
    if (lookupType === 'ENTITY_BY_UAL') {
      if (defaultPolicy === 'deny' && !this.hasAnyPublicParanet()) {
        return errorResponse('', 'ACCESS_DENIED', 'No paranets are queryable on this node');
      }
      return null;
    }

    const paranetConfig = this.config.paranets?.[paranetId!];
    if (!paranetConfig) {
      if (defaultPolicy === 'deny') {
        return errorResponse('', 'ACCESS_DENIED', `Paranet '${paranetId}' is not queryable`);
      }
      // defaultPolicy is 'public' — allow with default lookup types
      return null;
    }

    // Check peer access
    if (paranetConfig.policy === 'deny') {
      return errorResponse('', 'ACCESS_DENIED', `Paranet '${paranetId}' is not queryable`);
    }
    if (paranetConfig.policy === 'allowList') {
      if (!paranetConfig.allowedPeers?.includes(peerId)) {
        return errorResponse('', 'ACCESS_DENIED', 'Your peer ID is not in the allow list');
      }
    }

    // Check lookup type
    if (paranetConfig.allowedLookupTypes?.length) {
      if (!paranetConfig.allowedLookupTypes.includes(lookupType)) {
        return errorResponse('', 'UNSUPPORTED_LOOKUP', `Lookup type '${lookupType}' is not allowed for paranet '${paranetId}'`);
      }
    }

    // Check SPARQL specifically
    if (lookupType === 'SPARQL_QUERY' && !paranetConfig.sparqlEnabled) {
      return errorResponse('', 'UNSUPPORTED_LOOKUP', `SPARQL queries are not enabled for paranet '${paranetId}'`);
    }

    return null;
  }

  private hasAnyPublicParanet(): boolean {
    if (this.config.defaultPolicy === 'public') return true;
    if (!this.config.paranets) return false;
    return Object.values(this.config.paranets).some(p => p.policy === 'public');
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
      return {
        operationId: opId,
        status: 'OK',
        ntriples: '',
        truncated: false,
        resultCount: 0,
      };
    }
  }

  private async lookupByType(
    opId: string,
    paranetId: string,
    rdfType: string,
    limit: number,
  ): Promise<QueryResponse> {
    if (!rdfType) {
      return errorResponse(opId, 'ERROR', 'Invalid request: missing rdfType');
    }

    const dataGraph = paranetDataGraphUri(paranetId);
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
    paranetId: string,
    entityUri: string,
  ): Promise<QueryResponse> {
    if (!entityUri) {
      return errorResponse(opId, 'ERROR', 'Invalid request: missing entityUri');
    }

    const dataGraph = paranetDataGraphUri(paranetId);
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
    paranetId: string,
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
      return errorResponse(opId, 'ERROR', 'Explicit GRAPH clauses are not allowed in remote queries — queries are automatically scoped to the target paranet');
    }

    if (/\bFROM\s+/i.test(stripped)) {
      return errorResponse(opId, 'ERROR', 'FROM/FROM NAMED clauses are not allowed in remote queries — queries are automatically scoped to the target paranet');
    }

    const guard = validateReadOnlySparql(sparql);
    if (!guard.safe) {
      return errorResponse(opId, 'ERROR', `SPARQL rejected: ${guard.reason}`);
    }

    // Execute with timeout
    const result = await Promise.race([
      this.queryEngine.query(sparql, { paranetId }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeout),
      ),
    ]).catch(err => {
      if (err.message === 'timeout') {
        return { _timeout: true } as any;
      }
      throw err;
    });

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

