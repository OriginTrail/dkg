import { assertSafeIri } from '@origintrail-official/dkg-core';

export interface GraphRead {
  readonly pattern: string;
  readonly helperVariables: readonly string[];
}

/** Backend barriers and their helpers travel together with each graph read. */
export interface GraphAccess {
  candidate(inner: string, graph: string): GraphRead;
  replay(inner: string, graph: string, variables: string, bindings: GraphRead): GraphRead;
  fallback(inner: string): GraphRead;
}

const VIEW_GRAPH = '?__dkgViewGraph';
const MATCHED = '?__dkgDedupMatched';

export function createGraphAccess(mode: 'values' | 'dataset', graphs: readonly string[]): GraphAccess {
  const values = graphs.map(graph => `<${assertSafeIri(graph)}>`).join(' ');
  if (mode === 'values') {
    const candidate = (inner: string, graph: string): GraphRead => ({
      pattern: `VALUES ${graph} { ${values} } GRAPH ${graph} { ${inner} }`,
      helperVariables: [graph],
    });
    return {
      candidate,
      replay: (inner, graph, _variables, bindings) => ({
        pattern: `OPTIONAL { GRAPH ${graph} { ${inner} ${bindings.pattern} } }`,
        helperVariables: [graph, ...bindings.helperVariables],
      }),
      fallback: inner => candidate(inner, VIEW_GRAPH),
    };
  }
  // The conditional read binds the graph before Blazegraph evaluates a repeated
  // path. Its marker removes unmatched graphs without expanding a UNION per graph.
  const candidate = (inner: string, graph: string): GraphRead => ({
    pattern: `VALUES ${graph} { ${values} } OPTIONAL { GRAPH ${graph} { ${inner} } BIND(true AS ${MATCHED}) } FILTER(${MATCHED})`,
    helperVariables: [graph, MATCHED],
  });
  return {
    candidate,
    replay: (inner, graph, variables, bindings) => {
      const read = candidate(`${inner} ${bindings.pattern}`, graph);
      // An independent replay subquery prevents Blazegraph from duplicating
      // hidden-path mappings by flattening both path evaluations into one group.
      return {
        pattern: `{ SELECT ${variables} ${graph} ${bindings.helperVariables.join(' ')} WHERE { ${read.pattern} } }`,
        helperVariables: [...read.helperVariables, ...bindings.helperVariables],
      };
    },
    fallback: inner => ({ pattern: `GRAPH ${VIEW_GRAPH} { ${inner} }`, helperVariables: [VIEW_GRAPH] }),
  };
}
