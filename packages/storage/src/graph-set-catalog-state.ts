import {
  createSortedUniqueStringCatalog,
  insertSortedUniqueStringCatalog,
  removeSortedUniqueStringCatalog,
} from '@origintrail-official/dkg-core';
import type { SortedGraphCatalog } from './graph-set-index-store.js';

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
    if (this.ordered) {
      // `members.has(graph)` was false before the Set mutation, so the sorted
      // projection is guaranteed not to contain it under this class-owned
      // synchronization invariant. Assign the canonical point update directly;
      // an identity-triggered invalidation would only conceal a broken state.
      this.ordered = insertSortedUniqueStringCatalog(this.ordered, graph);
    }
    return true;
  }

  remove(graph: string): boolean {
    if (!this.members?.delete(graph)) return false;
    if (this.ordered) {
      // A successful Set deletion guarantees membership in the synchronized
      // projection; keep the incremental representation explicit.
      this.ordered = removeSortedUniqueStringCatalog(this.ordered, graph);
    }
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
