import { registeredSubGraphBranches, decodeRegisteredSubGraphName } from './registered-sub-graphs.js';
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
  // Keep UNION branches flat: Blazegraph 2.1.5 cannot lower a nested UNION
  // introduced by graph-scope lifting, even though the nested form is valid SPARQL.
  const branches = [
    ...(includeInventory ? [`
      ${nonEmptyNamedGraphEnumerationPattern('graph')}
      FILTER(?graph = <${root}> || STRSTARTS(STR(?graph), "${prefix}"))
    `] : []),
    ...registeredSubGraphBranches(contextGraphId),
    `GRAPH <${meta}> { ?assertion <http://dkg.io/ontology/assertionGraph> ?assertionGraph . }`,
    ...childContextGraphBranches(root),
  ];
  const result = await query(`SELECT DISTINCT ${includeInventory ? '?graph ' : ''}?name ?assertionGraph ?ctxGraph WHERE {
    ${branches.map(branch => `{ ${branch} }`).join(' UNION ')}
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

/** View routing needs sub-graph authority and child-CG fences, not assertion inventory. */
export async function readViewGraphAuthority(
  contextGraphId: string,
  query: (sparql: string) => Promise<QueryResult>,
): Promise<{ subGraphs: Set<string>; childContextGraphs: Set<string> }> {
  const root = assertSafeIri(contextGraphDataUri(contextGraphId));
  const branches = [...registeredSubGraphBranches(contextGraphId), ...childContextGraphBranches(root)];
  const result = await query(`SELECT DISTINCT ?name ?ctxGraph WHERE {
    ${branches.map(branch => `{ ${branch} }`).join(' UNION ')}
  }`);
  const authority = { subGraphs: new Set<string>(), childContextGraphs: new Set<string>() };
  if (result.type !== 'bindings') return authority;
  for (const row of result.bindings) {
    const name = decodeRegisteredSubGraphName(row.name);
    if (name !== undefined) authority.subGraphs.add(name);
    if (row.ctxGraph) authority.childContextGraphs.add(row.ctxGraph);
  }
  return authority;
}

function childContextGraphBranches(root: string): string[] {
  const prefix = escapeSparqlLiteral(`${root}/`);
  return ['a <https://dkg.network/ontology#ContextGraph>', '<https://dkg.network/ontology#registrationStatus> ?status'].map(pattern => `
    GRAPH ?g { ?ctxGraph ${pattern} . }
    FILTER(STR(?g) = CONCAT(STR(?ctxGraph), "/_meta"))
    FILTER(STRSTARTS(STR(?ctxGraph), "${prefix}"))
  `);
}
