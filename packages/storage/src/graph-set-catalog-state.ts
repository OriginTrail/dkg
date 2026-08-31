import { createSortedUniqueStringCatalog } from '@origintrail-official/dkg-core';
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
    this.ordered = null;
    return true;
  }

  remove(graph: string): boolean {
    if (!this.members?.delete(graph)) return false;
    this.ordered = null;
    return true;
  }

  sorted(): SortedGraphCatalog {
    if (!this.members) return createSortedUniqueStringCatalog([]);
    this.ordered ??= createSortedUniqueStringCatalog(this.members);
    return this.ordered;
  }
}
