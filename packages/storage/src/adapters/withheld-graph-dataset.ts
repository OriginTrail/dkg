import oxigraph from 'oxigraph';
import { NON_EMPTY_NAMED_GRAPH_ENUMERATION_QUERY } from './graph-enumeration-query.js';

type OxStore = InstanceType<typeof oxigraph.Store>;
type OxGraphName = oxigraph.NamedNode | oxigraph.BlankNode;

/**
 * The dataset of a query that must not read the withheld graphs: the store's
 * default graph and every enumerable named graph outside the withheld roots
 * (each root and every graph below it, `<root>/...`). Oxigraph evaluates the
 * query against this dataset only, whatever its patterns are, and a dataset
 * the query names itself (FROM / FROM NAMED) is replaced by it. Enumeration
 * and query run in one synchronous turn, so both see the same store state.
 */
export function withheldGraphQueryDataset(
  store: OxStore,
  roots: readonly string[],
  visible: (graph: string) => boolean,
): { default_graph: oxigraph.DefaultGraph[]; named_graphs: OxGraphName[] } {
  if (roots.some(root => typeof root !== 'string' || root.length === 0)) {
    throw new Error('Withheld graph roots must be non-empty IRIs');
  }
  const result = store.query(NON_EMPTY_NAMED_GRAPH_ENUMERATION_QUERY);
  const named: OxGraphName[] = [];
  for (const row of Array.isArray(result) ? result : []) {
    const graph = row instanceof Map ? row.get('g') : undefined;
    if ((graph?.termType !== 'NamedNode' && graph?.termType !== 'BlankNode') || !visible(graph.value)) continue;
    if (graph.termType === 'NamedNode' && roots.some(root => graph.value === root || graph.value.startsWith(`${root}/`))) continue;
    named.push(graph);
  }
  return { default_graph: [oxigraph.defaultGraph()], named_graphs: named };
}
