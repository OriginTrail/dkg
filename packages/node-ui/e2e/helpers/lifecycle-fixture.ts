interface ContextGraph { id: string; name: string; isSystem?: boolean }

/** The daemon also lists system graphs, which the product deliberately hides. */
export function requireSeededUserGraph(graphs: ContextGraph[], id: string): ContextGraph {
  const matches = graphs.filter(graph => graph.id === id);
  if (matches.length !== 1 || matches[0]!.isSystem || !matches[0]!.name) {
    throw new Error(`Required user context graph ${id} is not ready; observed: ${graphs.map(graph => `${graph.id}${graph.isSystem ? ' (system)' : ''}`).join(', ')}`);
  }
  return matches[0]!;
}
