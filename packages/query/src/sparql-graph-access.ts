import { assertSafeIri } from '@origintrail-official/dkg-core';
import type { VariableAllocator } from './sparql-rewrite-names.js';

/**
 * values: the graphs are listed in the query. dataset: the query's dataset selects them,
 * with a conditional read for repeated paths. named: the query's FROM NAMED holds exactly
 * the read's graphs, so a graph variable ranges over them and no list is written.
 */
export type GraphAccessMode = 'values' | 'dataset' | 'named';

interface FilterBindings {
  readonly pattern: string;
  /** These booleans must cross the replay subquery's projection boundary. */
  readonly projectedVariables: readonly string[];
}

/** Backend barriers share the rewrite's private-variable allocator. */
export interface GraphAccess {
  candidate(inner: string, graph: string): string;
  replay(inner: string, graph: string, variables: string, bindings: FilterBindings): string;
  fallback(inner: string): string;
}

export function createGraphAccess(mode: GraphAccessMode, graphs: readonly string[], allocate: VariableAllocator): GraphAccess {
  const values = graphs.map(graph => `<${assertSafeIri(graph)}>`).join(' ');
  const viewGraph = allocate('__dkgViewGraph');
  if (mode === 'values' || mode === 'named') {
    const candidate = mode === 'named'
      ? (inner: string, graph: string) => `GRAPH ${graph} { ${inner} }`
      : (inner: string, graph: string) => `VALUES ${graph} { ${values} } GRAPH ${graph} { ${inner} }`;
    return {
      candidate,
      replay: (inner, graph, _variables, bindings) => `OPTIONAL { GRAPH ${graph} { ${inner} ${bindings.pattern} } }`,
      fallback: inner => candidate(inner, viewGraph),
    };
  }
  // The conditional read binds the graph before Blazegraph evaluates a repeated
  // path. Its marker removes unmatched graphs without expanding a UNION per graph.
  const matched = allocate('__dkgDedupMatched');
  const candidate = (inner: string, graph: string) =>
    `VALUES ${graph} { ${values} } OPTIONAL { GRAPH ${graph} { ${inner} } BIND(true AS ${matched}) } FILTER(${matched})`;
  return {
    candidate,
    replay: (inner, graph, variables, bindings) => {
      const read = candidate(`${inner} ${bindings.pattern}`, graph);
      // An independent replay subquery prevents Blazegraph from duplicating
      // hidden-path mappings by flattening both path evaluations into one group.
      return `{ SELECT ${variables} ${graph} ${bindings.projectedVariables.join(' ')} WHERE { ${read} } }`;
    },
    fallback: inner => `GRAPH ${viewGraph} { ${inner} }`,
  };
}
