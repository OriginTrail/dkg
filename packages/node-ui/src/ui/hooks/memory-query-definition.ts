import { sparqlIri } from '@origintrail-official/dkg-core/sparql-safe';
import type { MemoryLayerKey, TrustLevel } from './useMemoryEntities.js';

const QUERY_CATALOG = 'http://dkg.io/ontology/profile/QueryCatalog';

/** Locally owned query parts, shared by inventory, preview and resource reads. */
export interface MemoryQueryDefinition {
  key: string;
  layer: TrustLevel;
  graphFilter: string;
  catalog?: boolean;
  predicateFilter?: string;
}

export function memoryQueryDefinitions(contextGraphId: string, includeCatalog = false): MemoryQueryDefinition[] {
  const root = `did:dkg:context-graph:${contextGraphId}`;
  const within = `STRSTARTS(STR(?g), ${JSON.stringify(root + '/')})`;
  const withoutMeta = `STR(?g) != ${JSON.stringify(root + "/meta")} && !CONTAINS(STR(?g), "/meta/") && !STRENDS(STR(?g), "/_meta")`;
  return [
    {
      key: 'wm', layer: 'working',
      graphFilter: `${within} &&
        (CONTAINS(STR(?g), "/assertion/") || CONTAINS(STR(?g), "/_working_memory/")) &&
        ${withoutMeta}`,
    },
    {
      key: 'swm', layer: 'shared',
      graphFilter: `${within} &&
        (STRENDS(STR(?g), "/_shared_memory") || CONTAINS(STR(?g), "/_shared_memory/")) &&
        STR(?g) != ${JSON.stringify(root + "/meta/_shared_memory")} &&
        !CONTAINS(STR(?g), "/meta/") && !CONTAINS(STR(?g), "/_shared_memory/staging/")`,
      predicateFilter: '?p != <http://dkg.io/ontology/workspaceOwner>',
    },
    {
      key: 'vm', layer: 'verified',
      graphFilter: `(STR(?g) = ${JSON.stringify(root)} || ${within}) &&
        !CONTAINS(STR(?g), "/assertion/") && !CONTAINS(STR(?g), "/_working_memory") &&
        !CONTAINS(STR(?g), "/_shared_memory") && !CONTAINS(STR(?g), "_verifiable_memory_meta") &&
        ${withoutMeta} &&
        !CONTAINS(STR(?g), "/_private") && !CONTAINS(STR(?g), "/_rules")`,
    },
    ...(includeCatalog ? (['wm', 'swm'] as const).map(layer => ({
      key: `catalog-${layer}`, layer: layer === 'wm' ? 'working' as const : 'shared' as const,
      catalog: true,
      // Replicas retain catalog layer graphs, without every author-local lifecycle predicate.
      graphFilter: layer === 'wm'
        ? `(STRSTARTS(STR(?g), ${JSON.stringify(root + '/meta/assertion/')}) ||
            STRSTARTS(STR(?g), ${JSON.stringify(root + '/meta/_working_memory/')}))`
        : `STRSTARTS(STR(?g), ${JSON.stringify(root + '/meta/_shared_memory/')}) ||
            STR(?g) = ${JSON.stringify(root + '/meta/_shared_memory')}`,
    })) : []),
  ];
}

export function definitionsForLayer(contextGraphId: string, layer?: MemoryLayerKey, includeCatalog = false) {
  return memoryQueryDefinitions(contextGraphId, includeCatalog)
    .filter(definition => !layer || definition.key === layer || definition.key === `catalog-${layer}`);
}

interface QueryParts {
  projection?: string;
  pattern?: string;
  graphs?: string[];
  filters?: string;
  bindings?: string;
  order?: string;
  limit: number;
  inventory?: boolean;
}

/** Compose known SPARQL parts; data is never inserted by rewriting a finished query. */
export function memoryQuery(definition: MemoryQueryDefinition, parts: QueryParts): string {
  const predicate = definition.predicateFilter ? `FILTER(${definition.predicateFilter})` : '';
  const triples = `${parts.pattern ?? '?s ?p ?o'} ${predicate}`;
  const pattern = parts.inventory ? `FILTER EXISTS { ${triples} }` : triples;
  return `SELECT ${parts.projection ?? '?s ?p ?o ?g'} WHERE {
    ${parts.graphs?.length ? `VALUES ?g { ${parts.graphs.map(sparqlIri).join(' ')} }` : ''}
    GRAPH ?g {
      ${definition.catalog ? `?catalog a <${QUERY_CATALOG}> .` : ''}
      ${pattern}
    }
    FILTER(${definition.graphFilter})
    ${parts.filters ?? ''}
    ${parts.bindings ?? ''}
  } ${parts.order ? `ORDER BY ${parts.order}` : ''} LIMIT ${parts.limit}`;
}
