import {
  compareCodePoint,
  createSortedUniqueStringCatalog,
} from '@origintrail-official/dkg-core';
import type { SortedGraphCatalog } from './graph-set-index-store.js';

function lowerBound(values: readonly string[], target: string): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (compareCodePoint(values[middle]!, target) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

function insertSorted(
  source: SortedGraphCatalog,
  graph: string,
): SortedGraphCatalog {
  const next = [...source];
  next.splice(lowerBound(source, graph), 0, graph);
  return Object.freeze(next) as SortedGraphCatalog;
}

function removeSorted(
  source: SortedGraphCatalog,
  graph: string,
): SortedGraphCatalog | null {
  const index = lowerBound(source, graph);
  if (source[index] !== graph) return null;
  const next = [...source];
  next.splice(index, 1);
  return Object.freeze(next) as SortedGraphCatalog;
}

/** Owns graph membership and the invalidation of its immutable sorted view. */
export class GraphSetCatalogState {
  private members: Set<string> | null = null;
  private ordered: SortedGraphCatalog | null = null;

  get initialized(): boolean {
    return this.members !== null;
  }

  get current(): ReadonlySet<string> | null {
    return this.members;
  }

  has(graph: string): boolean | undefined {
    return this.members?.has(graph);
  }

  clear(): void {
    this.members = null;
    this.ordered = null;
  }

  replace(next: Set<string>): { added: string[]; removed: string[] } {
    const previous = this.members ?? new Set<string>();
    const added = [...next].filter((graph) => !previous.has(graph)).sort();
    const removed = [...previous].filter((graph) => !next.has(graph)).sort();
    this.members = next;
    if (added.length > 0 || removed.length > 0) this.ordered = null;
    return { added, removed };
  }

  add(graph: string): boolean {
    if (!this.members || this.members.has(graph)) return false;
    this.members.add(graph);
    // Once the immutable projection exists, preserve it incrementally. The
    // former invalidation forced the next prefix read to sort the complete
    // graph set after every single graph mutation under publish load.
    if (this.ordered) this.ordered = insertSorted(this.ordered, graph);
    return true;
  }

  remove(graph: string): boolean {
    if (!this.members?.delete(graph)) return false;
    if (this.ordered) this.ordered = removeSorted(this.ordered, graph);
    return true;
  }

  /**
   * Return the ordered view only when it still describes the membership set
   * observed by the caller. An invalidation between an async cache read and
   * enumeration must be retried, not represented as an ordinary empty catalog.
   */
  sortedFor(members: ReadonlySet<string>): SortedGraphCatalog | null {
    if (this.members !== members) return null;
    this.ordered ??= createSortedUniqueStringCatalog(this.members);
    return this.ordered;
  }
}
