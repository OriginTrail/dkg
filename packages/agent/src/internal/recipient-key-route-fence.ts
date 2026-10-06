// SPDX-License-Identifier: Apache-2.0

import { DKG_ONTOLOGY } from '@origintrail-official/dkg-core';
import type { Quad, TripleStore } from '@origintrail-official/dkg-storage';

const AGENT_DID_PREFIX = 'did:dkg:agent:';
const UNSAFE_IRI_CHARACTER = /[\s<>"{}|\\^`]/;

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

const bare = (term: string): string => (term.startsWith('<') && term.endsWith('>') ? term.slice(1, -1) : term);

// A removal is proven harmless only by a bare IRI. Some adapters read an empty
// term as a wildcard and rewrite unsafe characters, so those never prove anything.
const isBareIri = (term: string | undefined): term is string => term !== undefined && term !== '' && !UNSAFE_IRI_CHARACTER.test(term);

const isKeyRouteFact = (quad: Quad): boolean => bare(quad.subject).startsWith(AGENT_DID_PREFIX)
  && RECIPIENT_KEY_ROUTE_PREDICATES.has(bare(quad.predicate));

/** What a store removal names; every field is optional because an absent one means "any". */
export interface RecipientRemovalScope {
  graph?: string;
  subject?: string;
  predicate?: string;
}

/**
 * A revision that moves only when a write can change which recipient keys or
 * routes a private-roster resolution finds. It ignores the job, share, metadata
 * and content writes that move the node-wide authority revision on a busy node.
 *
 * Fail closed: anything this class cannot prove irrelevant moves the revision.
 * A removal is irrelevant when its subject is not an agent DID, its predicate is
 * not a key or route predicate, or its graph has never held such a fact. The
 * lookup reads every named graph, so the graphs that hold key facts are
 * found by one scan and kept current from every write that names its quads.
 */
export class RecipientKeyRouteFence {
  private value = 0;
  private readonly keyGraphs = new Set<string>();
  private staleGeneration = 0;
  private scannedGeneration = -1;
  private scan: Promise<void> | null = null;

  constructor(private readonly store: TripleStore) {}

  get revision(): number {
    return this.value;
  }

  /**
   * A write is about to be dispatched. Its graphs are learned before the write
   * can commit, so no removal of one of them completes while it is unknown. A
   * write that names no quads makes every learned graph untrusted.
   */
  anticipate(quads?: readonly Quad[]): void {
    if (quads === undefined) {
      this.staleGeneration += 1;
      return;
    }
    for (const quad of quads) if (isKeyRouteFact(quad)) this.keyGraphs.add(bare(quad.graph));
  }

  /** Quads that were inserted, removed or replaced into a graph. */
  noteQuads(quads: readonly Quad[]): void {
    let changed = false;
    for (const quad of quads) {
      if (!isKeyRouteFact(quad)) continue;
      this.keyGraphs.add(bare(quad.graph));
      changed = true;
    }
    if (changed) this.value += 1;
  }

  /** A removal whose scope is known, in whole or in part. */
  noteRemoval(scope: RecipientRemovalScope): void {
    const { graph, subject, predicate } = scope;
    if (isBareIri(subject) && !subject.startsWith(AGENT_DID_PREFIX)) return;
    if (isBareIri(predicate) && !RECIPIENT_KEY_ROUTE_PREDICATES.has(predicate)) return;
    const named = graph === undefined ? undefined : bare(graph);
    if (isBareIri(named) && this.scannedGeneration === this.staleGeneration && !this.keyGraphs.has(named)) return;
    this.value += 1;
  }

  /** A write whose facts are not named (an UPDATE, a prefix delete, a replaced payload that was not seen). */
  noteUnscopedWrite(): void {
    this.value += 1;
    this.staleGeneration += 1;
  }

  /**
   * Make the set of key-holding graphs trustworthy before a resolution reads the
   * revision. A failed scan leaves it untrusted, so removals keep moving the
   * revision until a later scan succeeds.
   */
  async ensureReady(): Promise<void> {
    if (this.scannedGeneration === this.staleGeneration) return;
    this.scan ??= this.scanKeyGraphs().finally(() => { this.scan = null; });
    await this.scan;
  }

  private async scanKeyGraphs(): Promise<void> {
    const generation = this.staleGeneration;
    try {
      const result = await this.store.query(KEY_GRAPH_SCAN, { source: 'agent.recipientKeyRouteFence.scan' });
      if (result.type !== 'bindings') return;
      for (const row of result.bindings) {
        if (typeof row['g'] === 'string') this.keyGraphs.add(bare(row['g']));
      }
      if (generation === this.staleGeneration) this.scannedGeneration = generation;
    } catch {
      // Not ready: every removal that cannot be proven harmless by subject or predicate still moves the revision.
    }
  }
}
