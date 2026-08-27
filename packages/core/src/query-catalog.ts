import { GET_VIEWS, type GetView } from './memory-model.js';
import {
  assertQueryCatalogTemplate,
  normalizeQueryCatalogParameters,
  parseQueryCatalogParameters,
  renderQueryCatalogTemplate,
  serializeQueryCatalogParameters,
  type QueryCatalogParameterDefinition,
} from './query-catalog-parameters.js';

export const QUERY_CATALOG_SCHEMA_VERSION = 1;
export const QUERY_CATALOG_READ_CAPABILITIES = Object.freeze({
  canonicalItems: true,
  queryParameters: true,
  executionView: true,
} as const);
export const CONTEXT_GRAPH_QUERY_SUBGRAPH = '__context_graph';
export const USER_QUERY_CATALOG_SLUG = 'ui-saved-queries';
export const USER_QUERY_CATALOG_NAME = 'Saved queries';
export const USER_QUERY_CATALOG_DESCRIPTION = 'Queries saved from the Query tab.';

const PROFILE_NS = 'http://dkg.io/ontology/profile/';
const SCHEMA_NS = 'http://schema.org/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

export interface QueryCatalogItem {
  queryIri: string;
  catalogIri: string;
  slug: string;
  name: string;
  description?: string;
  sparql: string;
  resultColumn?: string;
  rank: number;
  catalogSlug: string;
  catalogName: string;
  catalogDescription?: string;
  catalogRank: number;
  subGraph: string;
  parameters: QueryCatalogParameterDefinition[];
  view?: GetView;
}

export interface QueryCatalog {
  slug: string;
  subGraph: string;
  name: string;
  description?: string;
  rank: number;
  queries: QueryCatalogItem[];
}

export interface QueryCatalogReadResponse {
  schemaVersion: typeof QUERY_CATALOG_SCHEMA_VERSION;
  capabilities: typeof QUERY_CATALOG_READ_CAPABILITIES;
  contextGraphId: string;
  graph: string;
  items: QueryCatalogItem[];
  /** Raw SELECT rows retained so older clients can continue to decode them. */
  result: {
    type: 'bindings';
    bindings: Array<Record<string, unknown>>;
  };
}

export class QueryCatalogContractError extends Error {
  readonly code = 'QUERY_CATALOG_CONTRACT_INCOMPATIBLE';

  constructor(message = 'Incompatible query-catalog daemon contract. Upgrade the daemon and retry.') {
    super(message);
    this.name = 'QueryCatalogContractError';
  }
}

export interface QueryCatalogWriteQuad {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
}

export interface DecodeQueryCatalogOptions {
  legacyView?: (queryIri: string, catalogIri: string) => GetView | undefined;
}

export interface PreparedQueryCatalogExecution {
  sparql: string;
  view?: GetView;
  subGraphName?: string;
}

export function prepareQueryCatalogExecution(
  query: Pick<QueryCatalogItem, 'sparql' | 'parameters' | 'view' | 'subGraph'>,
  values: Record<string, unknown> = {},
): PreparedQueryCatalogExecution {
  return {
    sparql: renderQueryCatalogTemplate(query.sparql, query.parameters, values),
    ...(query.view ? { view: query.view } : {}),
    ...(query.subGraph && query.subGraph !== CONTEXT_GRAPH_QUERY_SUBGRAPH
      ? { subGraphName: query.subGraph }
      : {}),
  };
}

export function queryCatalogBindingValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && !Array.isArray(value)) {
    const raw = (value as { value?: unknown }).value;
    if (typeof raw === 'string') return raw;
  }
  const raw = String(value);
  const literalMatch = raw.match(/^("[\s\S]*")(?:\^\^.*|@.*)?$/);
  if (!literalMatch) return raw.startsWith('<') && raw.endsWith('>')
    ? raw.slice(1, -1)
    : raw;
  try {
    return JSON.parse(literalMatch[1]);
  } catch {
    return literalMatch[1].slice(1, -1);
  }
}

function queryCatalogSlugFromIri(iri: string, marker: string, fallback: string): string {
  if (!iri) return fallback;
  return iri.split(marker).pop() ?? iri;
}

function oneValue(
  rows: readonly Record<string, unknown>[],
  field: string,
  queryIri: string,
): string {
  const values = new Set(
    rows.map((row) => queryCatalogBindingValue(row[field])).filter(Boolean),
  );
  if (values.size > 1) {
    throw new Error(`Saved query ${queryIri} has conflicting ${field} values.`);
  }
  return values.values().next().value ?? '';
}

function parseRank(value: string, fallback: number): number {
  const rank = Number.parseInt(value, 10);
  return Number.isFinite(rank) ? rank : fallback;
}

function parseView(value: string): GetView | undefined {
  return (GET_VIEWS as readonly string[]).includes(value) ? value as GetView : undefined;
}

function parseStoredView(value: string, field: string, queryIri: string): GetView | undefined {
  if (!value) return undefined;
  const parsed = parseView(value);
  if (!parsed) {
    throw new Error(`Saved query ${queryIri} has unsupported ${field} value: ${value}.`);
  }
  return parsed;
}

export function decodeQueryCatalogBindings(
  bindings: readonly unknown[],
  options: DecodeQueryCatalogOptions = {},
): QueryCatalogItem[] {
  const rowsByQuery = new Map<string, Record<string, unknown>[]>();
  for (const binding of bindings) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) continue;
    const row = binding as Record<string, unknown>;
    const queryIri = queryCatalogBindingValue(row.q);
    if (!queryIri) continue;
    const rows = rowsByQuery.get(queryIri) ?? [];
    rows.push(row);
    rowsByQuery.set(queryIri, rows);
  }

  const items: QueryCatalogItem[] = [];
  for (const [queryIri, rows] of rowsByQuery) {
    const sparql = oneValue(rows, 'sparql', queryIri);
    if (!sparql) continue;
    const catalogIri = oneValue(rows, 'catalog', queryIri);
    const slug = queryCatalogSlugFromIri(queryIri, ':query:', queryIri);
    const catalogSlug = queryCatalogSlugFromIri(
      catalogIri,
      ':catalog:',
      USER_QUERY_CATALOG_SLUG,
    );
    const executionView = parseStoredView(
      oneValue(rows, 'executionView', queryIri),
      'executionView',
      queryIri,
    );
    const legacyView = parseStoredView(oneValue(rows, 'view', queryIri), 'view', queryIri);
    if (executionView && legacyView && executionView !== legacyView) {
      throw new Error(`Saved query ${queryIri} has conflicting executionView and view values.`);
    }
    const explicitView = executionView ?? legacyView;
    items.push({
      queryIri,
      catalogIri,
      slug,
      name: oneValue(rows, 'name', queryIri) || slug,
      description: oneValue(rows, 'description', queryIri) || undefined,
      sparql,
      resultColumn: oneValue(rows, 'resultColumn', queryIri)
        || oneValue(rows, 'column', queryIri)
        || undefined,
      rank: parseRank(oneValue(rows, 'rank', queryIri), 99),
      catalogSlug,
      catalogName: oneValue(rows, 'catalogName', queryIri) || 'Queries',
      catalogDescription: oneValue(rows, 'catalogDescription', queryIri) || undefined,
      catalogRank: parseRank(oneValue(rows, 'catalogRank', queryIri), 999),
      subGraph: oneValue(rows, 'subGraph', queryIri) || CONTEXT_GRAPH_QUERY_SUBGRAPH,
      parameters: parseQueryCatalogParameters(
        oneValue(rows, 'queryParameters', queryIri) || undefined,
      ),
      view: explicitView ?? options.legacyView?.(queryIri, catalogIri),
    });
  }

  return items.sort((a, b) =>
    a.subGraph.localeCompare(b.subGraph)
    || a.catalogRank - b.catalogRank
    || a.rank - b.rank
    || a.name.localeCompare(b.name),
  );
}

/** Encode one deterministic row per saved query for legacy binding consumers. */
export function encodeQueryCatalogBindings(
  items: readonly QueryCatalogItem[],
): Array<Record<string, string>> {
  return items.map((item) => ({
    q: item.queryIri,
    ...(item.catalogIri ? { catalog: item.catalogIri } : {}),
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
    sparql: item.sparql,
    ...(item.resultColumn ? { resultColumn: item.resultColumn } : {}),
    ...(item.parameters.length > 0
      ? { queryParameters: serializeQueryCatalogParameters(item.parameters) }
      : {}),
    ...(item.view ? { executionView: item.view } : {}),
    subGraph: item.subGraph,
    rank: String(item.rank),
    catalogName: item.catalogName,
    ...(item.catalogDescription ? { catalogDescription: item.catalogDescription } : {}),
    catalogRank: String(item.catalogRank),
  }));
}

/**
 * Decode the versioned daemon DTO used by head clients. This deliberately does
 * not fall back to raw bindings: an older daemon cannot prove that it returned
 * parameter and execution-view metadata, so silently accepting that response
 * could execute a saved template with the wrong semantics.
 */
export function decodeQueryCatalogReadResponse(response: unknown): QueryCatalogItem[] {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new QueryCatalogContractError();
  }
  const envelope = response as Record<string, unknown>;
  const capabilities = envelope.capabilities as Record<string, unknown> | undefined;
  if (
    envelope.schemaVersion !== QUERY_CATALOG_SCHEMA_VERSION
    || capabilities?.canonicalItems !== true
    || capabilities?.queryParameters !== true
    || capabilities?.executionView !== true
    || !Array.isArray(envelope.items)
  ) {
    throw new QueryCatalogContractError();
  }

  return envelope.items.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new QueryCatalogContractError(`Invalid query-catalog item at index ${index}.`);
    }
    const item = raw as Record<string, unknown>;
    const requiredStrings = [
      'queryIri',
      'catalogIri',
      'slug',
      'name',
      'sparql',
      'catalogSlug',
      'catalogName',
      'subGraph',
    ] as const;
    for (const field of requiredStrings) {
      if (typeof item[field] !== 'string') {
        throw new QueryCatalogContractError(`Invalid query-catalog item ${index}: ${field} must be a string.`);
      }
    }
    if (
      typeof item.rank !== 'number'
      || !Number.isFinite(item.rank)
      || typeof item.catalogRank !== 'number'
      || !Number.isFinite(item.catalogRank)
    ) {
      throw new QueryCatalogContractError(`Invalid query-catalog item ${index}: ranks must be finite numbers.`);
    }
    const view = item.view === undefined ? undefined : parseView(String(item.view));
    if (item.view !== undefined && view === undefined) {
      throw new QueryCatalogContractError(`Invalid query-catalog item ${index}: unsupported execution view.`);
    }
    return {
      queryIri: item.queryIri as string,
      catalogIri: item.catalogIri as string,
      slug: item.slug as string,
      name: item.name as string,
      ...(typeof item.description === 'string' ? { description: item.description } : {}),
      sparql: item.sparql as string,
      ...(typeof item.resultColumn === 'string' ? { resultColumn: item.resultColumn } : {}),
      rank: item.rank as number,
      catalogSlug: item.catalogSlug as string,
      catalogName: item.catalogName as string,
      ...(typeof item.catalogDescription === 'string'
        ? { catalogDescription: item.catalogDescription }
        : {}),
      catalogRank: item.catalogRank as number,
      subGraph: item.subGraph as string,
      parameters: normalizeQueryCatalogParameters(item.parameters),
      ...(view ? { view } : {}),
    } satisfies QueryCatalogItem;
  });
}

export function groupQueryCatalogItems(items: readonly QueryCatalogItem[]): QueryCatalog[] {
  const byCatalog = new Map<string, QueryCatalog>();
  for (const item of items) {
    const key = `${item.subGraph}|${item.catalogSlug}`;
    const existing = byCatalog.get(key);
    if (existing) {
      if (
        existing.name !== item.catalogName
        || existing.description !== item.catalogDescription
        || existing.rank !== item.catalogRank
      ) {
        throw new Error(`Query catalog ${item.catalogSlug} has conflicting metadata.`);
      }
      existing.queries.push(item);
      continue;
    }
    byCatalog.set(key, {
      slug: item.catalogSlug,
      subGraph: item.subGraph,
      name: item.catalogName,
      description: item.catalogDescription,
      rank: item.catalogRank,
      queries: [item],
    });
  }
  return [...byCatalog.values()]
    .map((catalog) => ({
      ...catalog,
      queries: [...catalog.queries].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) =>
      a.subGraph.localeCompare(b.subGraph)
      || a.rank - b.rank
      || a.name.localeCompare(b.name),
    );
}

export function queryCatalogSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'saved-query';
}

export function queryCatalogProfileUri(
  contextGraphId: string,
  kind: 'catalog' | 'query',
  slug: string,
): string {
  return `urn:dkg:profile:${encodeURIComponent(contextGraphId)}:${kind}:${encodeURIComponent(slug)}`;
}

function literal(value: string): string {
  return JSON.stringify(value);
}

function intLiteral(value: number): string {
  return `"${value}"^^<${XSD_INTEGER}>`;
}

export function buildQueryCatalogWrite(input: {
  contextGraphId: string;
  name: string;
  description?: string;
  sparql: string;
  subGraph: string;
  catalogSlug: string;
  catalogName: string;
  catalogDescription?: string;
  resultColumn?: string;
  rank: number;
  catalogRank: number;
  parameters?: unknown;
  view?: GetView;
}): {
  savedQuery: QueryCatalogItem & { queryUri: string; catalogUri: string };
  quads: QueryCatalogWriteQuad[];
} {
  const slug = `${queryCatalogSlug(input.name)}-${input.rank.toString(36)}`;
  const catalogUri = queryCatalogProfileUri(input.contextGraphId, 'catalog', input.catalogSlug);
  const queryUri = queryCatalogProfileUri(input.contextGraphId, 'query', slug);
  const parameters = normalizeQueryCatalogParameters(input.parameters);
  assertQueryCatalogTemplate(input.sparql, parameters);
  const quads: QueryCatalogWriteQuad[] = [
    { subject: catalogUri, predicate: RDF_TYPE, object: `${PROFILE_NS}QueryCatalog`, graph: '' },
    { subject: catalogUri, predicate: `${PROFILE_NS}forSubGraph`, object: literal(input.subGraph), graph: '' },
    { subject: catalogUri, predicate: `${PROFILE_NS}displayName`, object: literal(input.catalogName), graph: '' },
    { subject: catalogUri, predicate: `${PROFILE_NS}rank`, object: intLiteral(input.catalogRank), graph: '' },
    { subject: queryUri, predicate: RDF_TYPE, object: `${PROFILE_NS}SavedQuery`, graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}forSubGraph`, object: literal(input.subGraph), graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}inCatalog`, object: catalogUri, graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}displayName`, object: literal(input.name), graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}sparqlQuery`, object: literal(input.sparql), graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}rank`, object: intLiteral(input.rank), graph: '' },
  ];
  if (input.catalogDescription) {
    quads.push({ subject: catalogUri, predicate: `${SCHEMA_NS}description`, object: literal(input.catalogDescription), graph: '' });
  }
  if (input.description) {
    quads.push({ subject: queryUri, predicate: `${SCHEMA_NS}description`, object: literal(input.description), graph: '' });
  }
  if (input.resultColumn) {
    quads.push({ subject: queryUri, predicate: `${PROFILE_NS}resultColumn`, object: literal(input.resultColumn), graph: '' });
  }
  if (parameters.length > 0) {
    quads.push({
      subject: queryUri,
      predicate: `${PROFILE_NS}queryParameters`,
      object: literal(serializeQueryCatalogParameters(parameters)),
      graph: '',
    });
  }
  if (input.view) {
    quads.push({
      subject: queryUri,
      predicate: `${PROFILE_NS}executionView`,
      object: literal(input.view),
      graph: '',
    });
  }
  return {
    savedQuery: {
      queryIri: queryUri,
      catalogIri: catalogUri,
      slug,
      name: input.name,
      description: input.description,
      sparql: input.sparql,
      resultColumn: input.resultColumn,
      rank: input.rank,
      catalogSlug: input.catalogSlug,
      catalogName: input.catalogName,
      catalogDescription: input.catalogDescription,
      catalogRank: input.catalogRank,
      subGraph: input.subGraph,
      parameters,
      view: input.view,
      queryUri,
      catalogUri,
    },
    quads,
  };
}
