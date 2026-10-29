import { registeredAssertionGraphPattern, CHILD_CONTEXT_GRAPH_PREDICATES, decodePartitionMetadataFact } from './partition-metadata-facts.js';
import { registeredSubGraphPattern, registeredSubGraphBranches, decodeRegisteredSubGraphName } from './registered-sub-graphs.js';
import { assertSafeIri, contextGraphDataUri, escapeSparqlLiteral } from '@origintrail-official/dkg-core';
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
  const prefix = escapeSparqlLiteral(`${root}/`);
  // Keep UNION branches flat: Blazegraph 2.1.5 cannot lower a nested UNION
  // introduced by graph-scope lifting, even though the nested form is valid SPARQL.
  const branches = [
    ...(includeInventory ? [`
      ${nonEmptyNamedGraphEnumerationPattern('graph')}
      FILTER(?graph = <${root}> || STRSTARTS(STR(?graph), "${prefix}"))
    `] : []),
    ...registeredSubGraphBranches(contextGraphId),
    registeredAssertionGraphPattern(contextGraphId),
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
    const fact = decodePartitionMetadataFact(row);
    if (fact.assertionGraph) catalog.assertionGraphs.add(fact.assertionGraph);
    if (fact.childContextGraph) catalog.childContextGraphs.add(fact.childContextGraph);
    const name = fact.subGraphName;
    if (name !== undefined) catalog.subGraphs.add(name);
  }
  return catalog;
}

/** Only sub-graph names are needed before enumeration; child authority is read afterward. */
export async function readRegisteredViewSubGraphs(contextGraphId: string,
  query: (sparql: string) => Promise<QueryResult>): Promise<Set<string>> {
  const result = await query(`SELECT DISTINCT ?name WHERE { ${registeredSubGraphPattern(contextGraphId)} }`);
  const names = new Set<string>();
  if (result.type === 'bindings') for (const row of result.bindings) {
    const name = decodeRegisteredSubGraphName(row.name);
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** Read the child fence after candidate discovery; an earlier fence can race registration. */
export async function readChildContextGraphAuthority(contextGraphId: string,
  query: (sparql: string) => Promise<QueryResult>): Promise<Set<string>> {
  const root = assertSafeIri(contextGraphDataUri(contextGraphId));
  const result = await query(`SELECT DISTINCT ?ctxGraph WHERE {
    ${childContextGraphBranches(root).map(branch => `{ ${branch} }`).join(' UNION ')}
  }`);
  return new Set(result.type === 'bindings' ? result.bindings.flatMap(row => row.ctxGraph ? [row.ctxGraph] : []) : []);
}

function childContextGraphBranches(root: string): string[] {
  const prefix = escapeSparqlLiteral(`${root}/`);
  return CHILD_CONTEXT_GRAPH_PREDICATES.map(pattern => `
    GRAPH ?g { ?ctxGraph ${pattern} . }
    FILTER(STR(?g) = CONCAT(STR(?ctxGraph), "/_meta"))
    FILTER(STRSTARTS(STR(?ctxGraph), "${prefix}"))
  `);
}
