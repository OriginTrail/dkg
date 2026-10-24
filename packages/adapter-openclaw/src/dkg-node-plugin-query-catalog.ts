/**
 * Query-catalog + SPARQL helpers for {@link DkgNodePlugin}.
 *
 * Pure, module-scope helpers extracted verbatim from `DkgNodePlugin.ts` to
 * keep the plugin class manageable. No behavior change — these are the same
 * functions/constants/types, only relocated. Imported back into
 * `DkgNodePlugin.ts` where used.
 */
import { escapeDkgRdfLiteral, isSafeIri } from '@origintrail-official/dkg-core';
import {
  CONTEXT_GRAPH_QUERY_SUBGRAPH,
  USER_QUERY_CATALOG_DESCRIPTION,
  USER_QUERY_CATALOG_NAME,
  USER_QUERY_CATALOG_SLUG,
  buildQueryCatalogWrite,
  decodeQueryCatalogReadResponse,
  queryCatalogBindingValue,
  queryCatalogSlug,
  type QueryCatalogItem,
  type QueryCatalogWriteQuad,
} from '@origintrail-official/dkg-core/query-catalog';

export {
  CONTEXT_GRAPH_QUERY_SUBGRAPH,
  USER_QUERY_CATALOG_DESCRIPTION,
  USER_QUERY_CATALOG_NAME,
  USER_QUERY_CATALOG_SLUG,
  queryCatalogSlug,
};
export type QueryCatalogToolItem = QueryCatalogItem;
export type { QueryCatalogWriteQuad };

export function stripRdfTerm(value: unknown): string {
  return queryCatalogBindingValue(value);
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

export function normalizeQueryCatalogItems(response: Record<string, unknown>): QueryCatalogToolItem[] {
  return decodeQueryCatalogReadResponse(response);
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

export const buildQueryCatalogSaveWrite = buildQueryCatalogWrite;
