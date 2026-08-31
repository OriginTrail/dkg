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
  const membershipIndex = new Map<string, number>();
  for (let index = 0; index < graphs.length; index += 1) {
    membershipIndex.set(graphs[index]!, index);
  }
  // Reuse one mark table for allocation-free membership equality checks. JS is
  // single-threaded between these synchronous operations, so one monotonically
  // stamped table also detects duplicate entries in a fresh graph listing.
  const matchMarks = new Uint32Array(graphs.length);
  let matchEpoch = 0;
  const matches = (candidates: readonly string[]): boolean => {
    if (candidates.length !== graphs.length) return false;
    matchEpoch = (matchEpoch + 1) >>> 0;
    if (matchEpoch === 0) {
      matchMarks.fill(0);
      matchEpoch = 1;
    }
    for (const graph of candidates) {
      const index = membershipIndex.get(graph);
      if (index === undefined || matchMarks[index] === matchEpoch) return false;
      matchMarks[index] = matchEpoch;
    }
    return true;
  };
  const snapshot: GraphMembershipSnapshot = Object.freeze({
    graphs,
    size: graphs.length,
    has: (graph: string) => membershipIndex.has(graph),
    matches,
    equalOrUnder: (
      graph: string,
      accept: (candidate: string) => boolean = acceptEveryGraph,
    ): string[] => {
      const selected: string[] = [];
      if (membershipIndex.has(graph) && accept(graph)) selected.push(graph);

      const prefix = `${graph}/`;
      for (let index = lowerBound(graphs, prefix); index < graphs.length; index += 1) {
        const candidate = graphs[index]!;
        if (!candidate.startsWith(prefix)) break;
        if (accept(candidate)) selected.push(candidate);
      }
      return selected;
    },
  });
  return snapshot;
}
