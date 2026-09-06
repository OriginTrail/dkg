import type { PeerId } from '@origintrail-official/dkg-core';
import { contextGraphDataUri, assertSafeIri } from '@origintrail-official/dkg-core';
import {
  isStoreSchedulerBusyError,
  quadsToNQuads,
  type StoreSchedulerBusyErrorLike,
} from '@origintrail-official/dkg-storage';
import { prepareSparql } from '@origintrail-official/dkg-rdf-utils/sparql';
import { validateReadOnlySparql } from './sparql-guard.js';
import type { DKGQueryEngine } from './dkg-query-engine.js';
import type {
  QueryRequest,
  QueryResponse,
  QueryAccessConfig,
  ContextGraphQueryPolicy,
  LookupType,
  NonBusyQueryStatus,
  QueryBusyResponse,
  QueryNonBusyResponse,
} from './query-types.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const MAX_RESULT_BYTES = 1_048_576; // 1 MB
const STORE_BUSY_RETRY_AFTER_MS = 1_000;
// PR #1107 review (🔴): cache isContextGraphPublic verdicts so repeated
// remote queries against the same CG don't each burn an RPC round-trip on
// the chain adapter. Short TTL keeps policy flips (public → private)
// bounded; the cache is size-capped so an attacker cycling CG ids can't
// grow it without bound.
const PUBLIC_CG_CACHE_TTL_MS = 60_000;
const PUBLIC_CG_CACHE_MAX_ENTRIES = 1000;

interface RateBucket {
  count: number;
  resetAt: number;
}

class UalResolutionError extends Error {
  constructor(readonly ual: string, cause: unknown) {
    super(`Failed to resolve UAL: ${ual}`, { cause });
    this.name = 'UalResolutionError';
  }
}

/**
 * Handles incoming cross-agent query requests over the
 * /dkg/query/2.0.0 libp2p protocol.
 *
 * Evaluates access policy, rate limits, dispatches to the local query
 * engine, and enforces result size limits.
 */
export interface QueryHandlerDeps {
  /**
   * #1105: optional resolver consulted when a CG has NO explicit
   * `queryAccess.contextGraphs` entry and `defaultPolicy` is 'deny'.
   * Should return true only for CGs whose own access policy is
   * provably public (e.g. live on-chain `accessPolicy === 0`). This
   * closes the gap where a CG created with `accessPolicy: "public"`
   * was still remotely unqueryable because the query ACL is a
   * separate, unshipped config surface. Failures must be treated as
   * "not public" by the resolver (fail closed).
   */
  isContextGraphPublic?: (contextGraphId: string) => Promise<boolean>;
}

export class QueryHandler {
  private readonly queryEngine: DKGQueryEngine;
  private readonly config: QueryAccessConfig;
  private readonly rateBuckets = new Map<string, RateBucket>();
  private readonly defaultRatePerMinute: number;
  private readonly deps: QueryHandlerDeps;
  private readonly publicCgCache = new Map<string, { value: boolean; expiresAt: number }>();

  constructor(queryEngine: DKGQueryEngine, config: QueryAccessConfig, deps: QueryHandlerDeps = {}) {
    this.queryEngine = queryEngine;
    this.config = config;
    this.defaultRatePerMinute = config.rateLimitPerMinute ?? 60;
    this.deps = deps;
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
    const contextGraphId = request.contextGraphId;
    if (request.lookupType !== 'ENTITY_BY_UAL' && !contextGraphId) {
      return errorResponse(opId, 'ERROR', 'Invalid request: contextGraphId is required for this lookup type');
    }

    // Rate limit check FIRST. PR #1107 review (🔴): `checkAccess` can do a
    // live chain lookup (the #1105 public-CG resolver), so running it before
    // the rate limiter let an unauthenticated peer burn RPC quota on every
    // request — including traffic that should already be throttled. Denied
    // requests intentionally consume rate budget so they stay cheap.
    const rateResult = this.checkRateLimit(peerId);
    if (rateResult) return { ...rateResult, operationId: opId };

    // Access policy check
    const accessResult = await this.checkAccess(request.lookupType, contextGraphId, peerId);
    if (accessResult) return { ...accessResult, operationId: opId };

    // Dispatch to lookup handler
    try {
      const limit = Math.min(request.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const timeout = Math.min(request.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const contextGraphPolicy = this.contextGraphPolicy(contextGraphId);

      let response: QueryNonBusyResponse;

      switch (request.lookupType) {
        case 'ENTITY_BY_UAL':
          response = await this.lookupByUAL(opId, request.ual!, peerId);
          break;
        case 'ENTITIES_BY_TYPE':
          response = await this.lookupByType(opId, contextGraphId!, request.rdfType!, limit);
          break;
        case 'ENTITY_TRIPLES':
          response = await this.lookupEntityTriples(opId, contextGraphId!, request.entityUri!);
          break;
        case 'SPARQL_QUERY':
          response = await this.executeSparql(
            opId,
            contextGraphId!,
            request.sparql!,
            capByPolicy(limit, contextGraphPolicy?.sparqlMaxResults),
            capByPolicy(timeout, contextGraphPolicy?.sparqlTimeout),
          );
          break;
        default:
          response = errorResponse(opId, 'UNSUPPORTED_LOOKUP', `Unknown lookup type: ${request.lookupType}`);
      }

      return this.enforceResultSize(response);
    } catch (err) {
      const busyError = storeSchedulerBusyCause(err);
      if (busyError) return storeBusyResponse(opId, busyError);
      if (err instanceof UalResolutionError) {
        return errorResponse(opId, 'ERROR', err.message);
      }
      return errorResponse(opId, 'ERROR', 'Internal error processing query');
    }
  }

  private async checkAccess(
    lookupType: LookupType,
    contextGraphId: string | undefined,
    peerId: string,
  ): Promise<QueryNonBusyResponse | null> {
    const defaultPolicy = this.config.defaultPolicy ?? 'deny';

    // ENTITY_BY_UAL: the target CG is only known AFTER the UAL resolves, so
    // per-CG enforcement happens post-resolution in `lookupByUAL` (PR #1107
    // review 🔴: the previous blanket `hasAnyPublicContextGraph()` gate never
    // consulted the #1105 on-chain resolver, so UAL lookups against
    // on-chain-public CGs stayed denied on fresh/default configs). Keep only
    // the cheap fast-deny for nodes that provably have nothing queryable:
    // default-deny, no config-public CG, and no resolver wired.
    if (lookupType === 'ENTITY_BY_UAL') {
      if (defaultPolicy === 'deny' && !this.hasAnyPublicContextGraph() && !this.deps.isContextGraphPublic) {
        return errorResponse('', 'ACCESS_DENIED', 'No context graphs are queryable on this node');
      }
      return null;
    }

    return this.checkContextGraphAccess(lookupType, contextGraphId!, peerId);
  }

  /**
   * Per-CG access evaluation shared by the upfront check (CG-scoped lookups)
   * and the post-resolution check for ENTITY_BY_UAL.
   */
  private async checkContextGraphAccess(
    lookupType: LookupType,
    contextGraphId: string,
    peerId: string,
  ): Promise<QueryNonBusyResponse | null> {
    const defaultPolicy = this.config.defaultPolicy ?? 'deny';
    const cgConfig = this.config.contextGraphs?.[contextGraphId];
    if (!cgConfig) {
      if (defaultPolicy === 'deny') {
        // #1105: a CG whose OWN access policy is provably public (live
        // on-chain accessPolicy=0) is remotely queryable even without an
        // explicit queryAccess entry — "public" would otherwise be a
        // discoverability flag that no remote peer can act on. Explicit
        // per-CG queryAccess entries (handled below) still take
        // precedence, so operators can deny or allowlist a public CG.
        if (await this.resolvePublicContextGraph(contextGraphId)) return null;
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

  /**
   * Cached wrapper around `deps.isContextGraphPublic`. The resolver may hit
   * the chain adapter (RPC), so verdicts are memoised for a short TTL and the
   * cache is size-capped (oldest-first eviction) to keep hostile traffic —
   * which has already paid the rate-limit toll — from amplifying into
   * unbounded RPC load or memory growth. Resolver failures are treated as
   * "not public" (fail closed) and cached like any other negative verdict.
   */
  private async resolvePublicContextGraph(contextGraphId: string): Promise<boolean> {
    if (!this.deps.isContextGraphPublic) return false;
    const now = Date.now();
    const cached = this.publicCgCache.get(contextGraphId);
    if (cached && now < cached.expiresAt) return cached.value;
    const value = await this.deps.isContextGraphPublic(contextGraphId).catch(() => false);
    if (this.publicCgCache.size >= PUBLIC_CG_CACHE_MAX_ENTRIES && !this.publicCgCache.has(contextGraphId)) {
      const oldest = this.publicCgCache.keys().next().value;
      if (oldest !== undefined) this.publicCgCache.delete(oldest);
    }
    this.publicCgCache.set(contextGraphId, { value, expiresAt: now + PUBLIC_CG_CACHE_TTL_MS });
    return value;
  }

  private hasAnyPublicContextGraph(): boolean {
    if (this.config.defaultPolicy === 'public') return true;
    const cgConfigs = this.config.contextGraphs ?? this.config.contextGraphs;
    if (!cgConfigs) return false;
    return Object.values(cgConfigs).some(p => p.policy === 'public');
  }

  private contextGraphPolicy(contextGraphId: string | undefined): ContextGraphQueryPolicy | undefined {
    if (!contextGraphId) return undefined;
    return this.config.contextGraphs?.[contextGraphId];
  }

  private checkRateLimit(peerId: string): QueryNonBusyResponse | null {
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

  private async lookupByUAL(opId: string, ual: string, peerId: string): Promise<QueryNonBusyResponse> {
    if (!ual) {
      return errorResponse(opId, 'ERROR', 'Invalid request: missing ual');
    }

    let resolved;
    try {
      resolved = this.queryEngine.resolveKnowledgeAsset
        ? await this.queryEngine.resolveKnowledgeAsset(ual)
        : await this.queryEngine.resolveKA(ual);
    } catch (cause) {
      throw new UalResolutionError(ual, cause);
    }

    // PR #1107 review (🔴): enforce the RESOLVED context graph's access
    // policy — config entry first (operator override), then the #1105
    // on-chain public resolver. Pre-fix, UAL lookups bypassed per-CG
    // evaluation entirely: they were denied for on-chain-public CGs on
    // default configs, yet allowed THROUGH explicitly denied CGs whenever
    // any other public CG existed on the node.
    const denied = await this.checkContextGraphAccess('ENTITY_BY_UAL', resolved.contextGraphId, peerId);
    if (denied) return { ...denied, operationId: opId };
    const ntriples = quadsToNQuads(
      resolved.quads.map((quad) => ({ ...quad, graph: '' })),
    );

    return {
      operationId: opId,
      status: 'OK',
      ntriples,
      truncated: false,
      resultCount: resolved.quads.length,
    };
  }

  private async lookupByType(
    opId: string,
    contextGraphId: string,
    rdfType: string,
    limit: number,
  ): Promise<QueryNonBusyResponse> {
    if (!rdfType) {
      return errorResponse(opId, 'ERROR', 'Invalid request: missing rdfType');
    }

    const dataGraph = assertSafeIri(contextGraphDataUri(contextGraphId));
    // Per-KA VM read-both: published data lives in …/_verifiable_memory/{addr}/{number} + (legacy) root.
    const sparql = `SELECT DISTINCT ?entity WHERE { GRAPH ?g { ?entity a <${assertSafeIri(rdfType)}> } FILTER(STRSTARTS(STR(?g), "${dataGraph}/_verifiable_memory/") || STR(?g) = "${dataGraph}") } LIMIT ${limit}`;

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
  ): Promise<QueryNonBusyResponse> {
    if (!entityUri) {
      return errorResponse(opId, 'ERROR', 'Invalid request: missing entityUri');
    }

    const dataGraph = assertSafeIri(contextGraphDataUri(contextGraphId));
    // Per-KA VM read-both: published data lives in …/_verifiable_memory/{addr}/{number} + (legacy) root.
    const sparql = `SELECT ?p ?o WHERE { GRAPH ?g { <${assertSafeIri(entityUri)}> ?p ?o } FILTER(STRSTARTS(STR(?g), "${dataGraph}/_verifiable_memory/") || STR(?g) = "${dataGraph}") }`;
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
  ): Promise<QueryNonBusyResponse> {
    if (!sparql) {
      return errorResponse(opId, 'ERROR', 'Invalid request: missing sparql');
    }

    const prepared = prepareSparql(sparql);
    if (prepared.status === 'malformed-uchar') {
      return errorResponse(opId, 'ERROR', 'SPARQL rejected: malformed Unicode code-point escape');
    }
    const codeWords = prepared.wordTokens;

    if (codeWords.has('SERVICE')) {
      return errorResponse(opId, 'ERROR', 'SERVICE clauses are not allowed in remote queries');
    }

    if (codeWords.has('GRAPH')) {
      return errorResponse(opId, 'ERROR', 'Explicit GRAPH clauses are not allowed in remote queries — queries are automatically scoped to the target context graph');
    }

    if (codeWords.has('FROM')) {
      return errorResponse(opId, 'ERROR', 'FROM/FROM NAMED clauses are not allowed in remote queries — queries are automatically scoped to the target context graph');
    }

    const guard = validateReadOnlySparql(prepared);
    if (!guard.safe) {
      return errorResponse(opId, 'ERROR', `SPARQL rejected: ${guard.reason}`);
    }

    // Execute with timeout.
    //
    // KNOWN LIMITATION (tracked follow-up to #764): this `Promise.race`
    // bounds the *response* latency but does not cancel the underlying
    // SPARQL execution — the engine has no cancellation hook, so an
    // expensive remote query keeps consuming CPU/memory in the background
    // until it completes naturally. Likewise `limit` below is applied as a
    // post-materialization `.slice()`, so a high-cardinality query is fully
    // materialized before being truncated. Genuinely enforcing either bound
    // requires threading an `AbortSignal` + result cap through
    // `QueryEngine.query()` → storage → the oxigraph worker. Injecting a
    // `LIMIT` into the user query here is NOT a safe shortcut: for scoped
    // queries it would push the statement into the multi-graph
    // solution-set-modifier rejection path (see #789), so it is
    // deliberately left to the engine-level follow-up.
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

  private enforceResultSize(response: QueryNonBusyResponse): QueryNonBusyResponse {
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

function errorResponse(
  opId: string,
  status: NonBusyQueryStatus,
  error: string,
): QueryNonBusyResponse {
  return {
    operationId: opId,
    status,
    truncated: false,
    resultCount: 0,
    error,
  };
}

function storeSchedulerBusyCause(
  error: unknown,
): StoreSchedulerBusyErrorLike | null {
  if (isStoreSchedulerBusyError(error)) return error;
  if (error instanceof UalResolutionError && isStoreSchedulerBusyError(error.cause)) {
    return error.cause;
  }
  return null;
}

function storeBusyResponse(
  opId: string,
  error: StoreSchedulerBusyErrorLike,
): QueryBusyResponse {
  return {
    operationId: opId,
    status: 'BUSY',
    truncated: false,
    resultCount: 0,
    error: 'Node storage is temporarily busy. Retry later.',
    code: 'STORE_BUSY',
    retryable: true,
    retryAfterMs: STORE_BUSY_RETRY_AFTER_MS,
    reason: error.reason,
  };
}

function capByPolicy(value: number, policyCap: number | undefined): number {
  if (policyCap === undefined || !Number.isFinite(policyCap) || policyCap <= 0) {
    return value;
  }
  return Math.min(value, Math.floor(policyCap));
}

function formatObject(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) return value;
  return `<${value}>`;
}

function encode(response: QueryResponse): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(response));
}
