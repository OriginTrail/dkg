import { registeredSubGraphPattern, decodeRegisteredSubGraphName } from './registered-sub-graphs.js';
import { assertSafeIri, contextGraphDataUri, contextGraphMetaUri, escapeSparqlLiteral } from '@origintrail-official/dkg-core';
import { nonEmptyNamedGraphEnumerationPattern, type QueryResult } from '@origintrail-official/dkg-storage';

/** One fresh store admission for scope authority and optional physical inventory.
 * UNION keeps these independent sets separate; joining them would multiply rows.
 * The caller retains all filtering and the existing all-writers memo contract.
 */
export async function readScopedContentGraphCatalog(
  contextGraphId: string,
  query: (sparql: string) => Promise<QueryResult>,
  includeInventory = true,
): Promise<{
  graphs: Set<string>;
  subGraphs: Set<string>;
  assertionGraphs: Set<string>;
  childContextGraphs: Set<string>;
}> {
  const root = assertSafeIri(contextGraphDataUri(contextGraphId));
  const meta = assertSafeIri(contextGraphMetaUri(contextGraphId));
  const prefix = escapeSparqlLiteral(`${root}/`);
  const inventory = includeInventory ? `{
      ${nonEmptyNamedGraphEnumerationPattern('graph')}
      FILTER(?graph = <${root}> || STRSTARTS(STR(?graph), "${prefix}"))
    } UNION` : '';
  const result = await query(`SELECT DISTINCT ${includeInventory ? '?graph ' : ''}?name ?assertionGraph ?ctxGraph WHERE {
    ${inventory} {
      ${registeredSubGraphPattern(contextGraphId)}
    } UNION {
      GRAPH <${meta}> { ?assertion <http://dkg.io/ontology/assertionGraph> ?assertionGraph . }
    } UNION {
      GRAPH ?g {
        { ?ctxGraph a <https://dkg.network/ontology#ContextGraph> . }
        UNION { ?ctxGraph <https://dkg.network/ontology#registrationStatus> ?status . }
      }
      FILTER(STR(?g) = CONCAT(STR(?ctxGraph), "/_meta"))
      FILTER(STRSTARTS(STR(?ctxGraph), "${prefix}"))
    }
  }`);
  const catalog = {
    graphs: new Set<string>(), subGraphs: new Set<string>(),
    assertionGraphs: new Set<string>(), childContextGraphs: new Set<string>(),
  };
  if (result.type !== 'bindings') return catalog;
  for (const row of result.bindings) {
    if (row.graph && (row.graph === root || row.graph.startsWith(`${root}/`))) catalog.graphs.add(row.graph);
    if (row.assertionGraph) catalog.assertionGraphs.add(row.assertionGraph);
    if (row.ctxGraph) catalog.childContextGraphs.add(row.ctxGraph);
    const name = decodeRegisteredSubGraphName(row.name);
    if (name !== undefined) catalog.subGraphs.add(name);
  }
  return catalog;
}
