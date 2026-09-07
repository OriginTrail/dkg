import {
  createSortedUniqueStringCatalog,
  insertSortedUniqueStringCatalog,
  removeSortedUniqueStringCatalog,
} from '@origintrail-official/dkg-core';
import type { SortedGraphCatalog } from './graph-set-index-store.js';

/**
 * Owns two synchronized representations of one graph set: `members` is the
 * mutable authority, while `ordered` is either null or its exact immutable,
 * unique, Unicode-code-point-sorted projection.
 */
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

  /** Apply one mixed presence reconciliation with at most one projection rebuild. */
  reconcile(
    graphPresence: Iterable<Readonly<{ graph: string; present: boolean }>>,
  ): { added: string[]; removed: string[] } {
    if (!this.members) return { added: [], removed: [] };
    const desiredPresence = new Map<string, boolean>();
    for (const { graph, present } of graphPresence) {
      desiredPresence.set(graph, present);
    }
    const added: string[] = [];
    const removed: string[] = [];
    for (const [graph, present] of desiredPresence) {
      if (present) {
        if (this.members.has(graph)) continue;
        this.members.add(graph);
        added.push(graph);
      } else if (this.members.delete(graph)) {
        removed.push(graph);
      }
    }
    if (this.ordered) {
      const mutationCount = added.length + removed.length;
      if (mutationCount === 1) {
        this.ordered = added.length === 1
          ? insertSortedUniqueStringCatalog(this.ordered, added[0]!)
          : removeSortedUniqueStringCatalog(this.ordered, removed[0]!);
      } else if (mutationCount > 1) {
        this.ordered = createSortedUniqueStringCatalog(this.members);
      }
    }
    return { added, removed };
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
