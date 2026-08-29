import { compareCodePoint } from './code-point-order.js';

export interface GraphMembershipSnapshot {
  /** Immutable, unique graph names in protocol code-point order. */
  readonly graphs: readonly string[];
  readonly size: number;
  has(graph: string): boolean;
  /** True when `graphs` describes the same membership, regardless of order. */
  matches(graphs: readonly string[]): boolean;
  /** Select an exact graph plus descendants below `${graph}/`. */
  equalOrUnder(
    graph: string,
    accept?: (candidate: string) => boolean,
  ): string[];
}

const snapshotByGraphArray = new WeakMap<readonly string[], GraphMembershipSnapshot>();
const acceptEveryGraph = () => true;

function lowerBound(graphs: readonly string[], target: string): number {
  let low = 0;
  let high = graphs.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compareCodePoint(graphs[middle]!, target) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function createGraphMembershipSnapshot(
  sourceGraphs: readonly string[],
): GraphMembershipSnapshot {
  const graphs = Object.freeze([...new Set(sourceGraphs)].sort(compareCodePoint));
  const membership = new Set(graphs);
  const snapshot: GraphMembershipSnapshot = Object.freeze({
    graphs,
    size: graphs.length,
    has: (graph: string) => membership.has(graph),
    matches: (candidates: readonly string[]) => (
      candidates.length === graphs.length
      && candidates.every((graph) => membership.has(graph))
    ),
    equalOrUnder: (
      graph: string,
      accept: (candidate: string) => boolean = acceptEveryGraph,
    ): string[] => {
      const selected: string[] = [];
      if (membership.has(graph) && accept(graph)) selected.push(graph);

      const prefix = `${graph}/`;
      for (let index = lowerBound(graphs, prefix); index < graphs.length; index += 1) {
        const candidate = graphs[index]!;
        if (!candidate.startsWith(prefix)) break;
        if (accept(candidate)) selected.push(candidate);
      }
      return selected;
    },
  });
  snapshotByGraphArray.set(graphs, snapshot);
  return snapshot;
}

/**
 * Recover the index attached to a responder memo result. Direct callers that
 * supply an ordinary array receive an equivalent one-shot snapshot.
 */
export function graphMembershipSnapshotFor(
  graphs: readonly string[],
): GraphMembershipSnapshot {
  return snapshotByGraphArray.get(graphs) ?? createGraphMembershipSnapshot(graphs);
}
