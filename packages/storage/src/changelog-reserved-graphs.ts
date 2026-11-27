import type { Quad } from './triple-store.js';
import { isAtomicGraphReplaceStagingGraph } from './atomic-graph-replace.js';

/** Public-store guard for the reconcile-owned changelog plane. */
export class ChangelogReservedGraphs {
  constructor(private readonly reserved: ReadonlySet<string>) {}

  /** Reject a graph-targeted mutation aimed at the reserved plane. Safe as a
   *  hard error: reserved graphs are never enumerated (listGraphs filters,
   *  hasGraph returns false), so no legitimate iterate-and-drop loop can reach
   *  one — only a hardcoded reserved IRI does. */
  assertNotReserved(graphUri: string, op: string): void {
    if (this.isReservedGraph(graphUri)) {
      throw new Error(
        `ChangelogStore: ${op}(<${graphUri}>) targets the reserved changelog plane, ` +
          `which is not writable through the public store API.`,
      );
    }
  }

  isReservedGraph(graphUri: string): boolean {
    return this.reserved.has(graphUri) || isAtomicGraphReplaceStagingGraph(graphUri);
  }

  /**
   * Reject an opaque SPARQL UPDATE that references a reserved graph IRI. A
   * best-effort guard against accidental mutation and the obvious hardcoded-IRI
   * vector — NOT airtight against hostile opaque SPARQL (prefixed forms evade
   * it). The structured paths (insert/delete/dropGraph) are the real guards; the
   * reserved plane's integrity ultimately rests on it being reconcile-derived.
   */
  assertNoReservedRef(sparql: string, op: string): void {
    for (const g of this.reserved) {
      if (sparql.includes(`<${g}>`)) {
        throw new Error(
          `ChangelogStore: ${op} references the reserved changelog graph <${g}>, ` +
            `which is not writable through the public store API.`,
        );
      }
    }
  }

  /** Reject a no-graph deleteByPattern whose subject/predicate is namespaced
   *  under a reserved graph (marker terms like `urn:dkg:changelog#seq`) — that
   *  would delete markers cross-graph. */
  assertNoReservedTerm(pattern: Partial<Quad>): void {
    const terms = [pattern.subject, pattern.predicate];
    for (const g of this.reserved) {
      if (terms.some((t) => t != null && t.startsWith(g))) {
        throw new Error(
          `ChangelogStore: deleteByPattern by a term under the reserved graph <${g}> ` +
            `would mutate the changelog plane, which is not writable through the public store API.`,
        );
      }
    }
  }
}
