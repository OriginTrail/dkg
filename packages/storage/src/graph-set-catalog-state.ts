import {
  createSortedUniqueStringCatalog,
  insertSortedUniqueStringCatalog,
  removeSortedUniqueStringCatalog,
} from '@origintrail-official/dkg-core';
import type { SortedGraphCatalog } from './graph-set-index-store.js';

type SortedCatalogFactory = typeof createSortedUniqueStringCatalog;

/** Owns graph membership and the invalidation of its immutable sorted view. */
export class GraphSetCatalogState {
  private members: Set<string> | null = null;
  private ordered: SortedGraphCatalog | null = null;

  constructor(
    private readonly createSortedCatalog: SortedCatalogFactory = createSortedUniqueStringCatalog,
  ) {}

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
      const previous = this.ordered;
      const next = insertSortedUniqueStringCatalog(previous, graph);
      this.ordered = next === previous ? null : next;
    }
    return true;
  }

  remove(graph: string): boolean {
    if (!this.members?.delete(graph)) return false;
    if (this.ordered) {
      const previous = this.ordered;
      const next = removeSortedUniqueStringCatalog(previous, graph);
      this.ordered = next === previous ? null : next;
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
    this.ordered ??= this.createSortedCatalog(this.members);
    return this.ordered;
  }
}
