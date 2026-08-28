import { createHash } from 'node:crypto';
import type { DKGAgent } from '@origintrail-official/dkg-agent';
import {
  CONTEXT_GRAPH_QUERY_SUBGRAPH,
  queryCatalogBindingValue,
  queryCatalogScopeGraphUri,
  queryCatalogSubGraphFromScopeGraph,
} from '@origintrail-official/dkg-core/query-catalog';
import {
  classifySparqlOperation,
  validateSubGraphName,
  type GetView,
} from '@origintrail-official/dkg-core';
import type {
  Quad,
  QueryResult as StoreQueryResult,
  StoreWorkPriority,
} from '@origintrail-official/dkg-storage';

const PROFILE_NS = 'http://dkg.io/ontology/profile/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SCHEMA_DESCRIPTION = 'http://schema.org/description';
const SAVED_QUERY = `${PROFILE_NS}SavedQuery`;
const QUERY_CATALOG = `${PROFILE_NS}QueryCatalog`;
const SCOPE_GRAPH = `${PROFILE_NS}scopeGraph`;
const FOR_SUB_GRAPH = `${PROFILE_NS}forSubGraph`;
const SPARQL_QUERY = `${PROFILE_NS}sparqlQuery`;
const IN_CATALOG = `${PROFILE_NS}inCatalog`;
const QUERY_CATALOG_META_SUBGRAPH = 'meta';
const QUERY_CATALOG_LIMIT_ROWS = 5_000;

const ALLOWED_QUERY_CATALOG_PREDICATES = new Set([
  RDF_TYPE,
  SCOPE_GRAPH,
  FOR_SUB_GRAPH,
  IN_CATALOG,
  `${PROFILE_NS}displayName`,
  SPARQL_QUERY,
  `${PROFILE_NS}resultColumn`,
  `${PROFILE_NS}queryParameters`,
  `${PROFILE_NS}executionView`,
  `${PROFILE_NS}view`,
  `${PROFILE_NS}rank`,
  SCHEMA_DESCRIPTION,
]);

export class QueryCatalogValidationError extends Error {
  readonly code = 'QUERY_CATALOG_INVALID_WRITE';

  constructor(message: string) {
    super(message);
    this.name = 'QueryCatalogValidationError';
  }
}

export class QueryCatalogWriteConflictError extends Error {
  readonly code = 'QUERY_CATALOG_WRITE_CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'QueryCatalogWriteConflictError';
  }
}

export interface QueryCatalogReadOptions {
  signal?: AbortSignal;
  priority?: StoreWorkPriority;
  source?: string;
  callerAgentAddress?: string;
  /** Temporary read-old bridge for canary data written before this rewrite. */
  includeLegacyDirectGraph?: boolean;
}

export interface QueryCatalogWriteOptions {
  callerAgentAddress?: string;
}

export interface QueryCatalogWriteResult {
  contextGraphId: string;
  graph: string;
  subGraphName: typeof QUERY_CATALOG_META_SUBGRAPH;
  assertionName: string;
  assertionUri: string;
  scopeGraphs: string[];
  /** Convenience field retained when the whole catalog has one scope. */
  scopeGraph?: string;
  queryCount: number;
  triplesWritten: number;
  alreadyExists: boolean;
}

export function contextGraphQueryCatalogMetaUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/${QUERY_CATALOG_META_SUBGRAPH}`;
}

export function legacyContextGraphQueryCatalogGraphUri(contextGraphId: string): string {
  return `did:dkg:context-graph:${contextGraphId}/meta/query-catalog`;
}

export function buildContextGraphQueryCatalogSelect(graph: string = '?g'): string {
  return `PREFIX prof: <${PROFILE_NS}>
PREFIX schema: <http://schema.org/>
SELECT ?q ?scopeGraph ?subGraph ?catalog ?name ?description ?sparql ?resultColumn ?queryParameters ?executionView ?view ?rank ?catalogScopeGraph ?catalogSubGraph ?catalogName ?catalogDescription ?catalogRank
WHERE {
  GRAPH ${graph} {
    ?q a prof:SavedQuery ;
       prof:sparqlQuery ?sparql .
    OPTIONAL { ?q prof:scopeGraph ?scopeGraph }
    OPTIONAL { ?q prof:forSubGraph ?subGraph }
    FILTER(BOUND(?scopeGraph) || BOUND(?subGraph))
    OPTIONAL { ?q prof:inCatalog ?catalog }
    OPTIONAL { ?q prof:displayName ?name }
    OPTIONAL { ?q schema:description ?description }
    OPTIONAL { ?q prof:resultColumn ?resultColumn }
    OPTIONAL { ?q prof:queryParameters ?queryParameters }
    OPTIONAL { ?q prof:executionView ?executionView }
    OPTIONAL { ?q prof:view ?view }
    OPTIONAL { ?q prof:rank ?rank }
    OPTIONAL { ?catalog prof:scopeGraph ?catalogScopeGraph }
    OPTIONAL { ?catalog prof:forSubGraph ?catalogSubGraph }
    OPTIONAL { ?catalog prof:displayName ?catalogName }
    OPTIONAL { ?catalog schema:description ?catalogDescription }
    OPTIONAL { ?catalog prof:rank ?catalogRank }
  }
}
ORDER BY ?q
LIMIT ${QUERY_CATALOG_LIMIT_ROWS + 1}`;
}

function bindingsFromAgentResult(
  result: Awaited<ReturnType<DKGAgent['query']>>,
): Array<Record<string, unknown>> {
  return result.bindings as Array<Record<string, unknown>>;
}

function bindingsFromStoreResult(result: StoreQueryResult): Array<Record<string, unknown>> {
  if (result.type !== 'bindings') {
    throw new Error(`Query catalog SELECT returned unexpected result type: ${result.type}`);
  }
  return result.bindings as Array<Record<string, unknown>>;
}

/**
 * Read the catalog through the Context Graph query engine so authorization,
 * view routing, cancellation, and the registered `meta` subgraph boundary are
 * the same as every other Context Graph read. The exact legacy graph is read
 * only during the migration window and is never a write target here.
 */
export async function readContextGraphQueryCatalogBindings(
  agent: DKGAgent,
  contextGraphId: string,
  options: QueryCatalogReadOptions = {},
): Promise<Array<Record<string, unknown>>> {
  const query = buildContextGraphQueryCatalogSelect();
  const baseOptions = {
    contextGraphId,
    subGraphName: QUERY_CATALOG_META_SUBGRAPH,
    signal: options.signal,
    priority: options.priority,
    source: options.source,
    callerAgentAddress: options.callerAgentAddress,
  };
  const views: GetView[] = [
    'working-memory',
    'shared-working-memory',
    'verifiable-memory',
  ];
  const layerReads = views.map(async (view) => bindingsFromAgentResult(await agent.query(query, {
    ...baseOptions,
    view,
    ...(view === 'working-memory' && options.callerAgentAddress
      ? { agentAddress: options.callerAgentAddress }
      : {}),
  })));

  const legacyRead = options.includeLegacyDirectGraph === false
    ? Promise.resolve([] as Array<Record<string, unknown>>)
    : agent.store.query(
      buildContextGraphQueryCatalogSelect(`<${legacyContextGraphQueryCatalogGraphUri(contextGraphId)}>`),
      {
        signal: options.signal,
        priority: options.priority,
        source: options.source ? `${options.source}.legacy` : undefined,
        maxResponseBytes: 1024 * 1024,
      },
    ).then(bindingsFromStoreResult);

  const rows = (await Promise.all([...layerReads, legacyRead])).flat();
  return rows;
}

function canonicalQuadKey(quad: Pick<Quad, 'subject' | 'predicate' | 'object'>): string {
  return JSON.stringify([quad.subject, quad.predicate, quad.object]);
}

function normalizedUniqueQuads(quads: readonly Quad[]): Quad[] {
  const byKey = new Map<string, Quad>();
  for (const quad of quads) {
    const normalized = {
      subject: quad.subject,
      predicate: quad.predicate,
      object: quad.object,
      graph: '',
    };
    byKey.set(canonicalQuadKey(normalized), normalized);
  }
  return [...byKey.values()].sort((left, right) =>
    canonicalQuadKey(left).localeCompare(canonicalQuadKey(right)),
  );
}

function oneObject(
  quads: readonly Quad[],
  subject: string,
  predicate: string,
  label: string,
): string | undefined {
  const values = new Set(
    quads
      .filter((quad) => quad.subject === subject && quad.predicate === predicate)
      .map((quad) => queryCatalogBindingValue(quad.object)),
  );
  if (values.size > 1) {
    throw new QueryCatalogValidationError(`${label} has conflicting values.`);
  }
  return values.values().next().value;
}

function subGraphFromScopeGraph(contextGraphId: string, scopeGraph: string): string {
  try {
    return queryCatalogSubGraphFromScopeGraph(contextGraphId, scopeGraph);
  } catch (error) {
    throw new QueryCatalogValidationError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function validateQueryCatalogWrite(
  agent: DKGAgent,
  contextGraphId: string,
  quads: readonly Quad[],
): Promise<{
  normalized: Quad[];
  scopeGraphs: string[];
  querySubjects: string[];
  catalogSubject?: string;
}> {
  const normalized = normalizedUniqueQuads(quads);
  const subjectPrefix = `urn:dkg:profile:${encodeURIComponent(contextGraphId)}:`;
  for (const quad of normalized) {
    if (!quad.subject.startsWith(subjectPrefix)) {
      throw new QueryCatalogValidationError(
        `Query-catalog subject <${quad.subject}> is outside context graph "${contextGraphId}".`,
      );
    }
    if (!ALLOWED_QUERY_CATALOG_PREDICATES.has(quad.predicate)) {
      throw new QueryCatalogValidationError(
        `Predicate <${quad.predicate}> is not part of the query-catalog contract.`,
      );
    }
  }

  const querySubjects = new Set(
    normalized
      .filter((quad) => quad.predicate === RDF_TYPE && quad.object === SAVED_QUERY)
      .map((quad) => quad.subject),
  );
  if (querySubjects.size === 0) {
    throw new QueryCatalogValidationError(
      'A query-catalog save must contain at least one prof:SavedQuery subject.',
    );
  }

  const catalogSubjects = [...new Set(normalized
    .filter((quad) => quad.predicate === RDF_TYPE && quad.object === QUERY_CATALOG)
    .map((quad) => quad.subject))];
  if (catalogSubjects.length > 1) {
    throw new QueryCatalogValidationError(
      'A query-catalog save may contain at most one prof:QueryCatalog subject.',
    );
  }
  const allowedSubjects = new Set([...querySubjects, ...catalogSubjects]);
  for (const quad of normalized) {
    if (!allowedSubjects.has(quad.subject)) {
      throw new QueryCatalogValidationError(
        `Query-catalog payload contains untyped subject <${quad.subject}>.`,
      );
    }
    if (
      quad.predicate === RDF_TYPE
      && quad.object !== SAVED_QUERY
      && quad.object !== QUERY_CATALOG
    ) {
      throw new QueryCatalogValidationError(
        `Unsupported query-catalog rdf:type <${quad.object}>.`,
      );
    }
  }

  const registered = await agent.listSubGraphs(contextGraphId);
  const registeredNames = new Set(registered.map((item) => item.name));
  const querySubGraphs = new Map<string, string>();
  const scopeGraphs = new Set<string>();
  const referencedCatalogs = new Set<string>();
  for (const querySubject of querySubjects) {
    const sparql = oneObject(normalized, querySubject, SPARQL_QUERY, 'Saved query SPARQL');
    if (!sparql) {
      throw new QueryCatalogValidationError(`Saved query <${querySubject}> is missing prof:sparqlQuery.`);
    }
    if (classifySparqlOperation(sparql).kind !== 'read') {
      throw new QueryCatalogValidationError(`Saved query <${querySubject}> SPARQL must be read-only.`);
    }

    const storedScopeGraph = oneObject(normalized, querySubject, SCOPE_GRAPH, 'Saved query scopeGraph');
    const legacySubGraph = oneObject(normalized, querySubject, FOR_SUB_GRAPH, 'Saved query forSubGraph');
    let subGraph = legacySubGraph ?? CONTEXT_GRAPH_QUERY_SUBGRAPH;
    let scopeGraph: string;
    if (storedScopeGraph) {
      subGraph = subGraphFromScopeGraph(contextGraphId, storedScopeGraph);
      if (legacySubGraph && legacySubGraph !== subGraph) {
        throw new QueryCatalogValidationError(
          `Saved query <${querySubject}> scopeGraph and forSubGraph identify different execution scopes.`,
        );
      }
      scopeGraph = storedScopeGraph;
    } else {
      try {
        scopeGraph = queryCatalogScopeGraphUri(contextGraphId, subGraph);
      } catch (error) {
        throw new QueryCatalogValidationError(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    if (subGraph !== CONTEXT_GRAPH_QUERY_SUBGRAPH) {
      const validation = validateSubGraphName(subGraph);
      if (!validation.valid) {
        throw new QueryCatalogValidationError(`Invalid query-catalog subgraph: ${validation.reason}`);
      }
      if (subGraph !== QUERY_CATALOG_META_SUBGRAPH && !registeredNames.has(subGraph)) {
        throw new QueryCatalogValidationError(
          `Query-catalog target subgraph "${subGraph}" is not registered in context graph "${contextGraphId}".`,
        );
      }
    }
    querySubGraphs.set(querySubject, subGraph);
    scopeGraphs.add(scopeGraph);
    if (!storedScopeGraph) {
      normalized.push({ subject: querySubject, predicate: SCOPE_GRAPH, object: scopeGraph, graph: '' });
    }
    if (!legacySubGraph) {
      normalized.push({ subject: querySubject, predicate: FOR_SUB_GRAPH, object: JSON.stringify(subGraph), graph: '' });
    }
    const referencedCatalog = oneObject(normalized, querySubject, IN_CATALOG, 'Saved query inCatalog');
    if (referencedCatalog) referencedCatalogs.add(referencedCatalog);
  }

  const catalogSubject = catalogSubjects[0];
  if (catalogSubject && (referencedCatalogs.size !== 1 || !referencedCatalogs.has(catalogSubject))) {
    throw new QueryCatalogValidationError(
      'Every saved query in a catalog batch must reference its prof:QueryCatalog subject.',
    );
  }
  if (catalogSubject) {
    let catalogScope = oneObject(normalized, catalogSubject, SCOPE_GRAPH, 'Query catalog scopeGraph');
    const catalogLegacySubGraph = oneObject(normalized, catalogSubject, FOR_SUB_GRAPH, 'Query catalog forSubGraph');
    const catalogSubGraph = catalogScope
      ? subGraphFromScopeGraph(contextGraphId, catalogScope)
      : catalogLegacySubGraph;
    if (!catalogSubGraph) {
      throw new QueryCatalogValidationError(
        'A prof:QueryCatalog subject must declare scopeGraph or forSubGraph.',
      );
    }
    if (!catalogScope) {
      catalogScope = queryCatalogScopeGraphUri(contextGraphId, catalogSubGraph);
      normalized.push({ subject: catalogSubject, predicate: SCOPE_GRAPH, object: catalogScope, graph: '' });
    }
    if (!catalogLegacySubGraph) {
      normalized.push({
        subject: catalogSubject,
        predicate: FOR_SUB_GRAPH,
        object: JSON.stringify(catalogSubGraph),
        graph: '',
      });
    }
    if (catalogScope && catalogLegacySubGraph && catalogSubGraph !== catalogLegacySubGraph) {
      throw new QueryCatalogValidationError(
        'Query catalog scopeGraph and forSubGraph identify different execution scopes.',
      );
    }
    if (catalogSubGraph) {
      for (const [querySubject, subGraph] of querySubGraphs) {
        if (subGraph !== catalogSubGraph) {
          throw new QueryCatalogValidationError(
            `Saved query <${querySubject}> and its catalog identify different execution scopes.`,
          );
        }
      }
    }
  }

  return {
    normalized: normalizedUniqueQuads(normalized),
    scopeGraphs: [...scopeGraphs].sort(),
    querySubjects: [...querySubjects].sort(),
    ...(catalogSubject ? { catalogSubject } : {}),
  };
}

function valuesForField(
  rows: readonly Record<string, unknown>[],
  field: string,
): Set<string> {
  return new Set(rows.map((row) => queryCatalogBindingValue(row[field])).filter(Boolean));
}

function assertExistingCatalogFieldCompatible(
  rows: readonly Record<string, unknown>[],
  field: string,
  desired: string | undefined,
  label: string,
): void {
  if (!desired) return;
  const existing = valuesForField(rows, field);
  if (existing.size > 1 || (existing.size === 1 && !existing.has(desired))) {
    throw new QueryCatalogWriteConflictError(
      `Existing query catalog has conflicting ${label}; immutable saves cannot replace it.`,
    );
  }
}

async function assertNoLogicalCatalogCollision(
  agent: DKGAgent,
  contextGraphId: string,
  normalized: readonly Quad[],
  querySubjects: readonly string[],
  catalogSubject: string | undefined,
  options: QueryCatalogWriteOptions,
): Promise<void> {
  const rows = await readContextGraphQueryCatalogBindings(agent, contextGraphId, {
    priority: 'background',
    source: 'api.profile.query_catalog.write.preflight',
    callerAgentAddress: options.callerAgentAddress,
  });
  const existingSubjects = new Set(rows.map((row) => queryCatalogBindingValue(row.q)));
  const collision = querySubjects.find((subject) => existingSubjects.has(subject));
  if (collision) {
    throw new QueryCatalogWriteConflictError(
      `Saved query <${collision}> already exists with different immutable content.`,
    );
  }
  if (!catalogSubject) return;

  const catalogRows = rows.filter(
    (row) => queryCatalogBindingValue(row.catalog) === catalogSubject,
  );
  if (catalogRows.length === 0) return;
  assertExistingCatalogFieldCompatible(
    catalogRows,
    'catalogScopeGraph',
    oneObject(normalized, catalogSubject, SCOPE_GRAPH, 'Query catalog scopeGraph'),
    'scopeGraph',
  );
  assertExistingCatalogFieldCompatible(
    catalogRows,
    'catalogSubGraph',
    oneObject(normalized, catalogSubject, FOR_SUB_GRAPH, 'Query catalog forSubGraph'),
    'forSubGraph',
  );
  assertExistingCatalogFieldCompatible(
    catalogRows,
    'catalogName',
    oneObject(normalized, catalogSubject, `${PROFILE_NS}displayName`, 'Query catalog displayName'),
    'displayName',
  );
  assertExistingCatalogFieldCompatible(
    catalogRows,
    'catalogDescription',
    oneObject(normalized, catalogSubject, SCHEMA_DESCRIPTION, 'Query catalog description'),
    'description',
  );
  assertExistingCatalogFieldCompatible(
    catalogRows,
    'catalogRank',
    oneObject(normalized, catalogSubject, `${PROFILE_NS}rank`, 'Query catalog rank'),
    'rank',
  );
}

const writeLocks = new Map<string, Promise<void>>();

async function withWriteLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  writeLocks.set(key, queued);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (writeLocks.get(key) === queued) writeLocks.delete(key);
  }
}

/**
 * Persist one immutable catalog entry as a normal WM Knowledge Asset in the
 * Context Graph's registered `meta` subgraph. A content-derived assertion name
 * makes transport retries idempotent. Partial append failures are recoverable
 * because retries only add missing triples and never delete existing data.
 */
export async function writeContextGraphQueryCatalog(
  agent: DKGAgent,
  contextGraphId: string,
  quads: readonly Quad[],
  options: QueryCatalogWriteOptions = {},
): Promise<QueryCatalogWriteResult> {
  const {
    normalized,
    scopeGraphs,
    querySubjects,
    catalogSubject,
  } = await validateQueryCatalogWrite(
    agent,
    contextGraphId,
    quads,
  );
  const payloadHash = createHash('sha256')
    .update(normalized.map(canonicalQuadKey).join('\n'))
    .digest('hex');
  const assertionName = `query-catalog-${payloadHash.slice(0, 32)}`;
  // Serialize all catalog saves for one caller/CG. Assertion-name locking is
  // insufficient because two different payloads for the same logical query
  // have different content hashes and could both pass the collision preflight.
  const lockKey = `${contextGraphId}\0${options.callerAgentAddress ?? ''}\0query-catalog`;
  const assertionOptions = {
    subGraphName: QUERY_CATALOG_META_SUBGRAPH,
    ...(options.callerAgentAddress ? { agentAddress: options.callerAgentAddress } : {}),
  };

  return withWriteLock(lockKey, async () => {
    const registered = await agent.listSubGraphs(contextGraphId);
    if (!registered.some((item) => item.name === QUERY_CATALOG_META_SUBGRAPH)) {
      await agent.createSubGraph(contextGraphId, QUERY_CATALOG_META_SUBGRAPH);
    }

    const existing = await agent.assertion.history(
      contextGraphId,
      assertionName,
      assertionOptions,
    );
    let assertionUri: string;
    let existingQuads: Quad[] = [];
    if (existing && existing.state !== 'discarded') {
      assertionUri = existing.assertionGraph;
      existingQuads = await agent.assertion.query(
        contextGraphId,
        assertionName,
        assertionOptions,
      );
    } else {
      await assertNoLogicalCatalogCollision(
        agent,
        contextGraphId,
        normalized,
        querySubjects,
        catalogSubject,
        options,
      );
      assertionUri = await agent.assertion.create(
        contextGraphId,
        assertionName,
        assertionOptions,
      );
    }

    const expectedByKey = new Map(normalized.map((quad) => [canonicalQuadKey(quad), quad]));
    const existingKeys = new Set(existingQuads.map(canonicalQuadKey));
    for (const key of existingKeys) {
      if (!expectedByKey.has(key)) {
        throw new QueryCatalogWriteConflictError(
          `Assertion "${assertionName}" contains data outside the immutable query-catalog payload.`,
        );
      }
    }
    const missing = normalized.filter((quad) => !existingKeys.has(canonicalQuadKey(quad)));
    if (missing.length > 0) {
      await agent.assertion.write(
        contextGraphId,
        assertionName,
        missing,
        assertionOptions,
      );
    }

    return {
      contextGraphId,
      graph: contextGraphQueryCatalogMetaUri(contextGraphId),
      subGraphName: QUERY_CATALOG_META_SUBGRAPH,
      assertionName,
      assertionUri,
      scopeGraphs,
      ...(scopeGraphs.length === 1 ? { scopeGraph: scopeGraphs[0] } : {}),
      queryCount: querySubjects.length,
      triplesWritten: missing.length,
      alreadyExists: missing.length === 0,
    };
  });
}
