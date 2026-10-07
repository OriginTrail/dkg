// SPDX-License-Identifier: Apache-2.0

import { AGENT_DID_PREFIX, DKG_ONTOLOGY, isSafeIri, unwrapIri } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';
import type { StoreMutation, StoreRemoval } from './store-mutation.js';

/** The predicates a recipient key lookup reads. Each is read only on an agent DID or key IRI subject. */
export const RECIPIENT_KEY_ROUTE_PREDICATES: ReadonlySet<string> = new Set([
  DKG_ONTOLOGY.DKG_PUBLIC_ENCRYPTION_KEY,
  DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_ALGORITHM,
  DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_PROOF,
  DKG_ONTOLOGY.DKG_PEER_ID,
  DKG_ONTOLOGY.DKG_REVOKED_AT,
  DKG_ONTOLOGY.DKG_REVOKED_BY,
  DKG_ONTOLOGY.DKG_ENCRYPTION_KEY_REVOCATION_PROOF,
]);

const KEY_GRAPH_SCAN = `SELECT DISTINCT ?g WHERE {
  VALUES ?p { ${[...RECIPIENT_KEY_ROUTE_PREDICATES].map((predicate) => `<${predicate}>`).join(' ')} }
  GRAPH ?g { ?s ?p ?o }
  FILTER(STRSTARTS(STR(?s), "${AGENT_DID_PREFIX}"))
}`;

// Harmlessness is proven only by a bare IRI that is not an agent DID. Some adapters
// read an empty term as a wildcard, rewrite unsafe characters, and turn a blank node
// in a delete into a variable that can match any subject; none of those prove
// anything, and `isSafeIri` refuses all of them (and brackets, and a name without
// a scheme).
const isNonAgentIri = (term: string | undefined): boolean => (
  term !== undefined && isSafeIri(term) && !term.startsWith(AGENT_DID_PREFIX)
);
const isBareIri = (term: string | undefined): term is string => term !== undefined && isSafeIri(term);

const isKeyRouteFact = (quad: Quad): boolean => (
  RECIPIENT_KEY_ROUTE_PREDICATES.has(unwrapIri(quad.predicate)) && !isNonAgentIri(unwrapIri(quad.subject))
);

/**
 * A revision that moves only when a write can change which recipient keys or
 * routes a private-roster resolution finds. It ignores the job, share, metadata
 * and content writes that move the node-wide authority revision on a busy node.
 *
 * Fail closed: anything this class cannot prove harmless moves the revision.
 * A removal is harmless when its subject is not an agent DID, its predicate is
 * not a key or route predicate, or its graph has never held such a fact. The
 * lookup reads every named graph, so the graphs that hold key facts are found
 * by one scan and kept current from every write that names its quads. While a
 * write that may change anything is in flight, or after one has changed
 * something, that list is not trusted until a scan has run again.
 */
export class RecipientKeyRouteFence {
  private value = 0;
  private readonly keyGraphs = new Set<string>();
  private staleGeneration = 0;
  private scannedGeneration = -1;
  private pendingEverything = 0;
  private scan: Promise<void> | null = null;

  constructor(private readonly store: TripleStore) {}

  get revision(): number {
    return this.value;
  }

  private get trusted(): boolean {
    return this.scannedGeneration === this.staleGeneration && this.pendingEverything === 0;
  }

  /**
   * A write is about to be dispatched. The graphs of its quads are learned before
   * it can commit, so no removal of one of them completes while it is unknown. A
   * write that may change anything makes the list untrusted until it has settled
   * and the graphs have been scanned again. Returns what to call when it settles.
   */
  begin(mutation: StoreMutation): () => void {
    for (const quad of mutation.quads ?? []) if (isKeyRouteFact(quad)) this.keyGraphs.add(unwrapIri(quad.graph));
    if (!mutation.everything) return () => undefined;
    this.staleGeneration += 1;
    this.pendingEverything += 1;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      this.pendingEverything -= 1;
    };
  }

  /** Quads that were inserted, removed or replaced into a graph. */
  noteQuads(quads: readonly Quad[]): void {
    let changed = false;
    for (const quad of quads) {
      if (!isKeyRouteFact(quad)) continue;
      this.keyGraphs.add(unwrapIri(quad.graph));
      changed = true;
    }
    if (changed) this.value += 1;
  }

  /** A removal whose scope is known, in whole or in part. */
  noteRemoval({ graph, subject, predicate }: StoreRemoval): void {
    if (isNonAgentIri(subject)) return;
    if (isBareIri(predicate) && !RECIPIENT_KEY_ROUTE_PREDICATES.has(predicate)) return;
    const named = graph === undefined ? undefined : unwrapIri(graph);
    if (isBareIri(named) && this.trusted && !this.keyGraphs.has(named)) return;
    this.value += 1;
  }

  /** A write that may have changed anything has changed something (an UPDATE, a prefix delete). */
  noteUnscopedWrite(): void {
    this.value += 1;
    this.staleGeneration += 1;
  }

  /**
   * Make the set of key-holding graphs trustworthy before a resolution reads the
   * revision. A failed scan, or one that overlapped a write that may change
   * anything, leaves it untrusted, so removals keep moving the revision until a
   * later scan.
   */
  async ensureReady(): Promise<void> {
    if (this.trusted) return;
    this.scan ??= this.scanKeyGraphs().finally(() => { this.scan = null; });
    await this.scan;
  }

  private async scanKeyGraphs(): Promise<void> {
    const generation = this.staleGeneration;
    try {
      const result = await this.store.query(KEY_GRAPH_SCAN, { source: 'agent.recipientKeyRouteFence.scan' });
      if (result.type !== 'bindings') return;
      for (const row of result.bindings) {
        if (typeof row['g'] === 'string') this.keyGraphs.add(unwrapIri(row['g']));
      }
      if (generation === this.staleGeneration && this.pendingEverything === 0) this.scannedGeneration = generation;
    } catch {
      // Not ready: every removal that cannot be proven harmless by subject or predicate still moves the revision.
    }
  }
}
