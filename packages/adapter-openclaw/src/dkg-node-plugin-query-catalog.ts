/**
 * Query-catalog + SPARQL helpers for {@link DkgNodePlugin}.
 *
 * Pure, module-scope helpers extracted verbatim from `DkgNodePlugin.ts` to
 * keep the plugin class manageable. No behavior change — these are the same
 * functions/constants/types, only relocated. Imported back into
 * `DkgNodePlugin.ts` where used.
 */
import { escapeDkgRdfLiteral, isSafeIri } from '@origintrail-official/dkg-core';

export const CONTEXT_GRAPH_QUERY_SUBGRAPH = '__context_graph';
export const USER_QUERY_CATALOG_SLUG = 'ui-saved-queries';
export const USER_QUERY_CATALOG_NAME = 'Saved queries';
export const USER_QUERY_CATALOG_DESCRIPTION = 'Queries saved from the Query tab.';
const PROFILE_NS = 'http://dkg.io/ontology/profile/';
const SCHEMA_NS = 'http://schema.org/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

export type QueryCatalogToolItem = {
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
};

export type QueryCatalogWriteQuad = {
  subject: string;
  predicate: string;
  object: string;
  graph: string;
};

export function stripRdfTerm(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const maybeValue = (value as Record<string, unknown>).value;
    if (typeof maybeValue === 'string') return maybeValue;
  }
  const raw = String(value ?? '');
  const decodeLiteral = (literal: string): string => {
    try {
      return JSON.parse(literal);
    } catch {
      return literal.slice(1, -1);
    }
  };
  const literalMatch = raw.match(/^("[\s\S]*")(\^\^.*|@.*)?$/);
  if (literalMatch) return decodeLiteral(literalMatch[1]);
  return raw;
}

export function quoteOpenClawLiteral(value: string): string {
  const escaped = escapeDkgRdfLiteral(value).replace(
    new RegExp(
      '[' +
        String.fromCharCode(0x00) + '-' + String.fromCharCode(0x1F) +
        String.fromCharCode(0x7F) +
      ']',
      'g',
    ),
    (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase(),
  );
  return `"${escaped}"`;
}

export function normalizeSemanticEnrichmentQuads(rawQuads: unknown): {
  quads?: Array<{ subject: string; predicate: string; object: string }>;
  error?: string;
} {
  if (!Array.isArray(rawQuads) || rawQuads.length === 0) {
    return { error: '"semantic_quads" must be a non-empty array of {subject, predicate, object} objects.' };
  }
  const quads: Array<{ subject: string; predicate: string; object: string }> = [];
  for (const [index, raw] of rawQuads.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { error: `"semantic_quads[${index}]" must be an object.` };
    }
    const record = raw as Record<string, unknown>;
    if (record.graph !== undefined && record.graph !== null) {
      return { error: `"semantic_quads[${index}].graph" is not supported; semantic triples are written to the source imported assertion graph.` };
    }
    const subject = typeof record.subject === 'string' ? record.subject.trim() : '';
    const predicate = typeof record.predicate === 'string' ? record.predicate.trim() : '';
    const object = typeof record.object === 'string' ? record.object.trim() : '';
    if (!subject || !predicate || !object) {
      return { error: `"semantic_quads[${index}]" must include non-empty subject, predicate, and object strings.` };
    }
    quads.push({
      subject,
      predicate,
      object: isSafeIri(object) || object.startsWith('"') ? object : quoteOpenClawLiteral(object),
    });
  }
  return { quads };
}

export function queryCatalogSlugFromIri(iri: string, marker: string, fallback: string): string {
  if (!iri) return fallback;
  return iri.split(marker).pop() ?? iri;
}

export function normalizeQueryCatalogItems(response: Record<string, unknown>): QueryCatalogToolItem[] {
  const result = response.result as { type?: string; bindings?: unknown[] } | undefined;
  const bindings = result?.type === 'bindings' && Array.isArray(result.bindings)
    ? result.bindings
    : [];
  return bindings
    .map((row): QueryCatalogToolItem | null => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
      const r = row as Record<string, unknown>;
      const qIri = stripRdfTerm(r.q);
      const catalogIri = stripRdfTerm(r.catalog);
      const slug = queryCatalogSlugFromIri(qIri, ':query:', qIri);
      const catalogSlug = queryCatalogSlugFromIri(catalogIri, ':catalog:', 'ui-saved-queries');
      const sparql = stripRdfTerm(r.sparql);
      if (!sparql) return null;
      return {
        slug,
        name: stripRdfTerm(r.name) || slug,
        description: r.description !== undefined ? stripRdfTerm(r.description) : undefined,
        sparql,
        resultColumn: r.resultColumn !== undefined ? stripRdfTerm(r.resultColumn) : undefined,
        rank: Number.parseInt(stripRdfTerm(r.rank) || '99', 10) || 99,
        catalogSlug,
        catalogName: stripRdfTerm(r.catalogName) || 'Queries',
        catalogDescription: r.catalogDescription !== undefined ? stripRdfTerm(r.catalogDescription) : undefined,
        catalogRank: Number.parseInt(stripRdfTerm(r.catalogRank) || '999', 10) || 999,
        subGraph: stripRdfTerm(r.subGraph),
      };
    })
    .filter((item): item is QueryCatalogToolItem => item !== null)
    .sort((a, b) =>
      a.subGraph.localeCompare(b.subGraph)
      || a.catalogRank - b.catalogRank
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

export function queryCatalogProfileUri(contextGraphId: string, kind: 'catalog' | 'query', slug: string): string {
  return `urn:dkg:profile:${encodeURIComponent(contextGraphId)}:${kind}:${encodeURIComponent(slug)}`;
}

export function queryCatalogLiteral(value: string): string {
  return JSON.stringify(value);
}

export function queryCatalogIntLiteral(value: number): string {
  return `"${value}"^^<${XSD_INTEGER}>`;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function contextGraphBelongsToCaller(row: Record<string, unknown>): boolean {
  if (row.isSystem === true) return false;
  if (row.callerInvolved === true) return true;
  if (row.callerInvolved === false) return false;
  const role = typeof row.role === 'string' ? row.role.trim().toLowerCase() : '';
  if (['curator', 'creator', 'owner', 'participant', 'member'].includes(role)) return true;
  // Older daemons did not include callerInvolved. Preserve compatibility by
  // leaving those unscoped rows visible instead of hiding everything.
  return true;
}

export function filterContextGraphsForScope(graphs: unknown[], scope: string | undefined): unknown[] {
  return scope === 'all'
    ? graphs
    : graphs.filter((graph) => graph && typeof graph === 'object' && contextGraphBelongsToCaller(graph as Record<string, unknown>));
}

export function readOnlySparqlOperation(sparql: string): string | null {
  const normalized = sparql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .trim();
  // Strip leading PREFIX/BASE prologue declarations one at a time with an
  // anchored, unambiguous pattern. The previous single regex nested `\s*` inside
  // a `(?:…)*` group, which CodeQL flagged for catastrophic backtracking; the
  // iterative form below is linear. (`[^\s<]+` for the prefix label cannot
  // overlap the following `<…>`, removing the remaining ambiguity.)
  const prologueDecl = /^(?:PREFIX\s+[^\s<]+\s*<[^>]+>|BASE\s+<[^>]+>)\s*/i;
  let rest = normalized;
  for (let m = rest.match(prologueDecl); m && m[0].length > 0; m = rest.match(prologueDecl)) {
    rest = rest.slice(m[0].length);
  }
  const match = rest.match(/^(SELECT|ASK|CONSTRUCT|DESCRIBE)\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

export function buildQueryCatalogSaveWrite(input: {
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
}): {
  savedQuery: QueryCatalogToolItem & {
    queryUri: string;
    catalogUri: string;
    resultColumn?: string;
  };
  quads: QueryCatalogWriteQuad[];
} {
  const slug = `${queryCatalogSlug(input.name)}-${input.rank.toString(36)}`;
  const catalogUri = queryCatalogProfileUri(input.contextGraphId, 'catalog', input.catalogSlug);
  const queryUri = queryCatalogProfileUri(input.contextGraphId, 'query', slug);
  const quads: QueryCatalogWriteQuad[] = [
    { subject: catalogUri, predicate: RDF_TYPE, object: `${PROFILE_NS}QueryCatalog`, graph: '' },
    { subject: catalogUri, predicate: `${PROFILE_NS}forSubGraph`, object: queryCatalogLiteral(input.subGraph), graph: '' },
    { subject: catalogUri, predicate: `${PROFILE_NS}displayName`, object: queryCatalogLiteral(input.catalogName), graph: '' },
    { subject: catalogUri, predicate: `${PROFILE_NS}rank`, object: queryCatalogIntLiteral(input.catalogRank), graph: '' },
    { subject: queryUri, predicate: RDF_TYPE, object: `${PROFILE_NS}SavedQuery`, graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}forSubGraph`, object: queryCatalogLiteral(input.subGraph), graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}inCatalog`, object: catalogUri, graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}displayName`, object: queryCatalogLiteral(input.name), graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}sparqlQuery`, object: queryCatalogLiteral(input.sparql), graph: '' },
    { subject: queryUri, predicate: `${PROFILE_NS}rank`, object: queryCatalogIntLiteral(input.rank), graph: '' },
  ];
  if (input.catalogDescription) {
    quads.push({ subject: catalogUri, predicate: `${SCHEMA_NS}description`, object: queryCatalogLiteral(input.catalogDescription), graph: '' });
  }
  if (input.description) {
    quads.push({ subject: queryUri, predicate: `${SCHEMA_NS}description`, object: queryCatalogLiteral(input.description), graph: '' });
  }
  if (input.resultColumn) {
    quads.push({ subject: queryUri, predicate: `${PROFILE_NS}resultColumn`, object: queryCatalogLiteral(input.resultColumn), graph: '' });
  }
  return {
    savedQuery: {
      slug,
      name: input.name,
      description: input.description,
      sparql: input.sparql,
      rank: input.rank,
      catalogSlug: input.catalogSlug,
      catalogName: input.catalogName,
      catalogDescription: input.catalogDescription,
      catalogRank: input.catalogRank,
      subGraph: input.subGraph,
      queryUri,
      catalogUri,
      resultColumn: input.resultColumn,
    },
    quads,
  };
}
